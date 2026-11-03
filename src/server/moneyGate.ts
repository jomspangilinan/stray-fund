import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db, withColonyLock, type Tx } from "./db/client";
import { agentActions, payouts, reviewRequests, users } from "./db/schema";
import { enqueueWakeup } from "./wakeups";
import { BATCH_EXISTS_FLAG, mayHaveReachedPayPal } from "./payoutRetry";
import { checkSpend, type GuardrailCode, type SpendRequest } from "./guardrails";
import {
  describeGatewayError,
  type PayoutCreateResult,
  type PayoutGateway,
} from "./paypal/payouts";

export type PayoutStatus =
  | "awaiting_approval"
  | "queued"
  | "sent"
  | "succeeded"
  | "failed"
  | "needs_review"
  | "rejected";

export type PayoutRequest = SpendRequest & { reason: string; inputs: object };

/** A guardrail denial has status "rejected", a code, and no payoutId when no row exists. */
export type GateResult = {
  status: PayoutStatus;
  payoutId?: string;
  actionId: string;
  code?: GuardrailCode;
  message?: string;
};

export type PayoutStatusUpdate = {
  itemStatus?: string;
  itemId?: string;
  fee?: number;
  /** The payout row id, when PayPal's event carries it. Finds a row with no batch id yet. */
  senderBatchId?: string;
};

export type ReviewResolution =
  | { outcome: "paid"; paypalRef: string }
  | { outcome: "not_paid"; note: string };

type Payout = typeof payouts.$inferSelect;

/** The original send plus five retries. */
const MAX_ATTEMPTS = 6;
const RETRY_AFTER_SECONDS = 30;
const LIVE_PAYOUT_INDEX = "payouts_booking_kind_live_idx";

/** A send attempted this recently may still be in flight, so not_paid is refused. */
export const IN_FLIGHT_WINDOW_SECONDS = 60;

const ITEM_SUCCEEDED = new Set(["SUCCESS"]);
/** Proven final and the money did not stay gone: PayPal says funds were not deducted, or came back. */
const ITEM_FAILED = new Set(["FAILED", "RETURNED", "REFUNDED", "CANCELED"]);
/**
 * Not proven final. BLOCKED says only "has been blocked" and the docs do not say where the funds are; REVERSED is
 * documented for web uploads only. Both can still clear to SUCCESS, so they hold the reservation for a caretaker.
 */
const ITEM_UNSETTLED = new Set(["BLOCKED", "REVERSED"]);
/** Money that really did come back after a success. */
const ITEM_UNDOES_SUCCESS = new Set(["RETURNED", "REFUNDED"]);
const BATCH_DEAD = new Set(["DENIED", "CANCELED"]);

/** Drizzle wraps driver errors, so the Postgres error may be on the cause chain. */
function isLivePayoutViolation(e: unknown): boolean {
  for (let cur = e; cur instanceof Error; cur = cur.cause) {
    const pg = cur as Error & { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === LIVE_PAYOUT_INDEX) return true;
  }
  return false;
}

/** Merged, not replaced, so the agent's original inputs stay on the record. */
const mergedInputs = (extra: object) =>
  sql`coalesce(${agentActions.inputs}, '{}'::jsonb) || ${JSON.stringify(extra)}::jsonb`;

function deniedAction(r: PayoutRequest, code: GuardrailCode) {
  return {
    action: `payout_${r.kind}`,
    inputs: {
      ...r.inputs,
      code,
      bookingId: r.bookingId,
      catId: r.catId,
      payeeId: r.payeeId,
    },
    reason: r.reason,
    amount: r.amount,
    status: "denied",
  };
}

async function enqueueStatusChange(
  tx: Tx,
  payout: Payout,
  status: PayoutStatus,
  extra: { code?: GuardrailCode; alert?: string; lateBatchId?: string } = {},
): Promise<void> {
  await enqueueWakeup(tx, "payout_status_changed", {
    payoutId: payout.id,
    catId: payout.catId,
    bookingId: payout.bookingId,
    kind: payout.kind,
    status,
    previousStatus: payout.status,
    ...extra,
  });
}

async function isBatchOnAnotherPayout(tx: Tx, batchId: string, payoutId: string): Promise<boolean> {
  const [other] = await tx
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.paypalPayoutBatchId, batchId), ne(payouts.id, payoutId)));
  return other !== undefined;
}

/**
 * PayPal has shown that a batch exists for a payout already marked failed, so its
 * money may have left while the reservation is free. Status stays failed, since
 * terminal states do not regress. This keeps the evidence and asks for a person.
 */
async function recordBatchAfterFailed(
  tx: Tx,
  payout: Payout,
  current: Payout,
  batchId: string | undefined,
  error: string | undefined,
): Promise<void> {
  if (batchId && current.paypalPayoutBatchId === batchId) return;
  const flagged = `${BATCH_EXISTS_FLAG}: ${error ?? "late batch"}`;
  if (!batchId && current.lastGatewayError === flagged) return;

  const canStore =
    batchId !== undefined &&
    current.paypalPayoutBatchId === null &&
    !(await isBatchOnAnotherPayout(tx, batchId, payout.id));
  console.error(
    `Payout ${payout.id} is failed but PayPal reports batch ${batchId ?? "(no id)"}${canStore ? "" : ", not stored"}`,
  );
  await tx
    .update(payouts)
    .set({
      lastGatewayError: flagged,
      ...(canStore ? { paypalPayoutBatchId: batchId } : {}),
    })
    .where(eq(payouts.id, payout.id));
  await enqueueStatusChange(tx, { ...payout, status: "failed" }, "failed", {
    alert: "batch_exists_after_failed",
    lateBatchId: batchId,
  });
}

async function currentStatus(payoutId: string): Promise<PayoutStatus> {
  const [row] = await db
    .select({ status: payouts.status })
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  return row.status as PayoutStatus;
}

/**
 * Commits a payout's move to its next status and returns the status it ends up in.
 * A batch id is good news from any attempt, and also clears a needs_review that
 * a newer attempt caused. Bad news only counts from the latest attempt on a
 * queued row. A batch id never replaces a different one already on the row.
 */
async function settle(
  payout: Payout,
  status: "sent" | "failed" | "needs_review",
  fields: { batchId?: string; error?: string },
): Promise<PayoutStatus> {
  const moved = await db.transaction(async (tx) => {
    const rows = await tx
      .update(payouts)
      .set({
        status,
        paypalPayoutBatchId: fields.batchId
          ? sql`coalesce(${payouts.paypalPayoutBatchId}, ${fields.batchId})`
          : undefined,
        lastGatewayError: fields.error,
      })
      .where(
        and(
          eq(payouts.id, payout.id),
          status === "sent"
            ? inArray(payouts.status, ["queued", "needs_review"])
            : and(eq(payouts.status, "queued"), eq(payouts.attempts, payout.attempts)),
        ),
      )
      .returning({ batchId: payouts.paypalPayoutBatchId });
    if (rows.length === 0) {
      if (status === "sent") {
        const [current] = await tx
          .select()
          .from(payouts)
          .where(eq(payouts.id, payout.id))
          .for("update");
        if (current.status === "failed") {
          await recordBatchAfterFailed(tx, payout, current, fields.batchId, fields.error);
        }
      }
      return false;
    }
    const kept = rows[0].batchId;
    if (fields.batchId && kept !== fields.batchId) {
      console.error(`Payout ${payout.id} keeps batch ${kept}, ignoring ${fields.batchId}`);
    }
    await tx
      .update(agentActions)
      .set({
        status,
        paypalRef: fields.batchId ? kept : undefined,
        ...(fields.error ? { inputs: mergedInputs({ gatewayError: fields.error }) } : {}),
      })
      .where(eq(agentActions.id, payout.actionId));
    if (status !== "sent") await enqueueStatusChange(tx, payout, status);
    return true;
  });
  return moved ? status : currentStatus(payout.id);
}

/**
 * PayPal says the batch exists but gave no id to poll. Holds from any attempt, so
 * it also flags a row a newer attempt already sent to review. Status stays
 * reserved and a person decides, with not_paid refused.
 */
async function recordBatchExists(payout: Payout, error: string): Promise<PayoutStatus> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .for("update");
    if (current.status === "failed") {
      await recordBatchAfterFailed(tx, payout, current, undefined, error);
      return;
    }
    if (current.status !== "queued" && current.status !== "needs_review") return;

    const flagged = `${BATCH_EXISTS_FLAG}: ${error}`;
    await tx
      .update(payouts)
      .set({ status: "needs_review", lastGatewayError: flagged })
      .where(eq(payouts.id, payout.id));
    await tx
      .update(agentActions)
      .set({ status: "needs_review", inputs: mergedInputs({ gatewayError: flagged }) })
      .where(eq(agentActions.id, payout.actionId));
    if (current.status === "queued") await enqueueStatusChange(tx, current, "needs_review");
  });
  return currentStatus(payout.id);
}

async function applyCreateResult(
  payout: Payout,
  result: PayoutCreateResult,
): Promise<PayoutStatus> {
  switch (result.kind) {
    case "sent":
      return settle(payout, "sent", { batchId: result.batchId });
    case "duplicate":
      // Proof the batch exists, on a first attempt as much as a retry, so never failed.
      return result.batchId
        ? settle(payout, "sent", { batchId: result.batchId, error: result.error })
        : recordBatchExists(payout, result.error);
    case "rejected":
      // On a retry PayPal may be refusing a batch it already accepted, so a
      // person has to look. Only a first attempt proves the money never left.
      return settle(payout, payout.attempts > 1 ? "needs_review" : "failed", {
        error: result.error,
      });
    case "unknown":
      if (payout.attempts >= MAX_ATTEMPTS) {
        return settle(payout, "needs_review", { error: result.error });
      }
      await db
        .update(payouts)
        .set({ lastGatewayError: result.error })
        .where(
          and(
            eq(payouts.id, payout.id),
            eq(payouts.status, "queued"),
            eq(payouts.attempts, payout.attempts),
          ),
        );
      return currentStatus(payout.id);
  }
}

/**
 * The only caller of gw.create. senderBatchId is always the payout row id.
 *
 * The compare-and-swap on attempts commits before the call, so a crash after it
 * reads as a retry, and two racing senders cannot both win the same attempt.
 */
async function send(
  payoutId: string,
  expectedAttempts: number,
  gw: PayoutGateway,
): Promise<PayoutStatus> {
  const [claimed] = await db
    .update(payouts)
    .set({ attempts: sql`${payouts.attempts} + 1`, lastAttemptAt: sql`now()` })
    .where(
      and(
        eq(payouts.id, payoutId),
        eq(payouts.status, "queued"),
        eq(payouts.attempts, expectedAttempts),
      ),
    )
    .returning();
  if (!claimed) return currentStatus(payoutId);

  const [payee] = await db
    .select({ email: users.paypalEmail })
    .from(users)
    .where(eq(users.id, claimed.payeeUserId));
  if (!payee?.email) {
    return settle(claimed, "needs_review", { error: "Payee has no PayPal email" });
  }

  let result: PayoutCreateResult;
  try {
    result = await gw.create({
      senderBatchId: claimed.id,
      receiver: payee.email,
      amount: claimed.amount,
      // Built from row fields, never from model text, and the same on every retry.
      note: `Stray Fund vet ${claimed.kind}, booking ${claimed.bookingId}`,
    });
  } catch (e) {
    // A throw tells us nothing about whether the money left.
    result = { kind: "unknown", error: e instanceof Error ? e.name : "Error" };
  }
  return applyCreateResult(claimed, result);
}

/**
 * The single path through which an agent can move money. Guardrails and row
 * inserts run under the colony lock and commit before the gateway is called.
 * Amount, payee and booking come from trusted code, never from the model.
 */
export async function requestPayout(r: PayoutRequest, gw: PayoutGateway): Promise<GateResult> {
  const spend: SpendRequest = {
    catId: r.catId,
    payeeId: r.payeeId,
    amount: r.amount,
    kind: r.kind,
    receiptId: r.receiptId,
    bookingId: r.bookingId,
  };

  let decided: GateResult;
  try {
    decided = await withColonyLock(async (tx): Promise<GateResult> => {
      const verdict = await checkSpend(tx, spend);
      if (verdict.verdict === "deny") {
        const [denied] = await tx
          .insert(agentActions)
          .values(deniedAction(r, verdict.code))
          .returning();
        return {
          status: "rejected",
          actionId: denied.id,
          code: verdict.code,
          message: verdict.message,
        };
      }

      const status: PayoutStatus =
        verdict.verdict === "needs_approval" ? "awaiting_approval" : "queued";
      const [action] = await tx
        .insert(agentActions)
        .values({
          action: `payout_${r.kind}`,
          inputs: r.inputs,
          reason: r.reason,
          amount: r.amount,
          status,
        })
        .returning();
      const [payout] = await tx
        .insert(payouts)
        .values({
          catId: r.catId,
          bookingId: r.bookingId,
          payeeUserId: r.payeeId,
          amount: r.amount,
          kind: r.kind,
          // checkSpend only vouched for a receipt on a balance.
          receiptId: r.kind === "balance" ? r.receiptId : undefined,
          actionId: action.id,
          status,
        })
        .returning();
      return { status, payoutId: payout.id, actionId: action.id };
    });
  } catch (e) {
    if (!isLivePayoutViolation(e)) throw e;
    // The violation aborted that transaction, so the denial commits on its own.
    const code: GuardrailCode = "DUPLICATE_PAYOUT";
    const [denied] = await db.insert(agentActions).values(deniedAction(r, code)).returning();
    return {
      status: "rejected",
      actionId: denied.id,
      code,
      message: `This booking already has a live ${r.kind} payout.`,
    };
  }

  if (decided.status !== "queued") return decided;
  return { ...decided, status: await send(decided.payoutId!, 0, gw) };
}

async function loadForDecision(tx: Tx, payoutId: string, caretakerId: string): Promise<Payout> {
  const [caretaker] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, caretakerId));
  if (caretaker?.role !== "caretaker") {
    throw new Error("Only a caretaker can decide on a payout");
  }
  const [payout] = await tx.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!payout) throw new Error(`Payout not found: ${payoutId}`);
  return payout;
}

/** Denials at approve time that a person can fix, so they must not make a permanent rejected row. */
const LEAVE_WAITING: ReadonlySet<GuardrailCode> = new Set(["REVIEW_REQUIRED", "OVER_DAY_CAP", "OVER_CAT_CAP"]);

/**
 * Re-runs the guardrails, since limits and bookings can change while a payout
 * waits. A payout no longer awaiting approval is left alone, so a double approve
 * pays once.
 */
export async function approvePayout(
  payoutId: string,
  caretakerId: string,
  gw: PayoutGateway,
): Promise<GateResult> {
  // Set only by the approval that moved the row to queued. A replay that finds
  // it already queued must not send.
  let attemptsToClaim: number | undefined;
  const decided = await withColonyLock(async (tx): Promise<GateResult> => {
    const payout = await loadForDecision(tx, payoutId, caretakerId);
    const base = { payoutId, actionId: payout.actionId };
    if (payout.status !== "awaiting_approval") {
      return { ...base, status: payout.status as PayoutStatus };
    }

    const verdict = await checkSpend(
      tx,
      {
        catId: payout.catId,
        payeeId: payout.payeeUserId,
        amount: payout.amount,
        kind: payout.kind as SpendRequest["kind"],
        receiptId: payout.receiptId ?? undefined,
        bookingId: payout.bookingId,
      },
      { approvingPayoutId: payoutId },
    );

    if (verdict.verdict === "deny" && LEAVE_WAITING.has(verdict.code)) {
      // Fixable: a cap can be raised, a block can be cleared. The row stays waiting and the reason is shown.
      return { ...base, status: "awaiting_approval", code: verdict.code, message: verdict.message };
    }
    if (verdict.verdict === "deny") {
      await tx.update(payouts).set({ status: "rejected" }).where(eq(payouts.id, payoutId));
      await tx
        .update(agentActions)
        .set({
          status: "rejected",
          approvedBy: caretakerId,
          inputs: mergedInputs({ code: verdict.code }),
        })
        .where(eq(agentActions.id, payout.actionId));
      await enqueueStatusChange(tx, payout, "rejected", { code: verdict.code });
      return { ...base, status: "rejected", code: verdict.code, message: verdict.message };
    }

    // Stamped now, not at the claim, so the next approval's day cap already counts
    // this one today. It also keeps the sweep off the send about to start.
    await tx
      .update(payouts)
      .set({ status: "queued", lastAttemptAt: sql`now()` })
      .where(eq(payouts.id, payoutId));
    await tx
      .update(agentActions)
      .set({ status: "queued", approvedBy: caretakerId })
      .where(eq(agentActions.id, payout.actionId));
    attemptsToClaim = payout.attempts;
    return { ...base, status: "queued" };
  });

  if (attemptsToClaim === undefined) return decided;
  return { ...decided, status: await send(payoutId, attemptsToClaim, gw) };
}

/** Frees the reservation of a waiting payout. Money that may have left stays reserved. */
export async function rejectPayout(
  payoutId: string,
  caretakerId: string,
  reason: string,
): Promise<GateResult> {
  return withColonyLock(async (tx): Promise<GateResult> => {
    const payout = await loadForDecision(tx, payoutId, caretakerId);
    const base = { payoutId, actionId: payout.actionId };
    if (payout.status !== "awaiting_approval") {
      return { ...base, status: payout.status as PayoutStatus };
    }
    await tx.update(payouts).set({ status: "rejected" }).where(eq(payouts.id, payoutId));
    await tx
      .update(agentActions)
      .set({
        status: "rejected",
        inputs: mergedInputs({ rejectionReason: reason, rejectedBy: caretakerId }),
      })
      .where(eq(agentActions.id, payout.actionId));
    await enqueueStatusChange(tx, payout, "rejected");
    return { ...base, status: "rejected" };
  });
}

/**
 * Once a payout has a batch id at PayPal, no one can rule it not paid from review: PayPal has not said the money
 * did not leave or came back, and a new payout would be a second payment. BLOCKED and REVERSED stay in review with
 * their money held until a developer closes them. Whether the desk offers "It was not paid" is this same rule.
 * A send still in flight is checked on submit.
 */
export function canRuleNotPaid(p: Parameters<typeof mayHaveReachedPayPal>[0]): boolean {
  return !mayHaveReachedPayPal(p);
}

/** not_paid frees the reservation, so it needs every sign the money stayed put. */
async function refuseIfMoneyMayHaveLeft(tx: Tx, payout: Payout): Promise<void> {
  if (payout.lastGatewayError?.startsWith(BATCH_EXISTS_FLAG)) {
    throw new Error("Cannot rule not_paid: PayPal reports this batch already exists");
  }
  if (payout.paypalPayoutBatchId) {
    throw new Error("Cannot rule not_paid: this payout has a PayPal batch");
  }
  const { rows } = await tx.execute(sql`
    select 1 from payouts
    where id = ${payout.id}
      and last_attempt_at > clock_timestamp() - make_interval(secs => ${IN_FLIGHT_WINDOW_SECONDS})
  `);
  if (rows.length > 0) {
    throw new Error("Cannot rule not_paid: a send may still be in flight, try again shortly");
  }
  if (mayHaveReachedPayPal(payout)) {
    throw new Error("Cannot rule not_paid: this payout may have reached PayPal (more than one send, or a PayPal status). A developer must close it.");
  }
}

/**
 * A caretaker's ruling on a payout nobody could settle automatically. Only acts
 * from needs_review, so a second resolve is a no-op. The original action keeps
 * its record and a new action row holds the ruling.
 */
export async function resolveNeedsReview(
  payoutId: string,
  caretakerId: string,
  r: ReviewResolution,
): Promise<GateResult> {
  const evidence = (r.outcome === "paid" ? r.paypalRef : r.note).trim();
  if (!evidence) {
    throw new Error(
      r.outcome === "paid" ? "A paid resolution needs a PayPal reference" : "A not_paid resolution needs a note",
    );
  }

  return withColonyLock(async (tx): Promise<GateResult> => {
    const payout = await loadForDecision(tx, payoutId, caretakerId);
    const base = { payoutId, actionId: payout.actionId };
    if (payout.status === "failed" && payout.lateSuccessReviewId) {
      return resolveLateSuccess(tx, payout, caretakerId, r, evidence);
    }
    if (payout.status !== "needs_review") {
      return { ...base, status: payout.status as PayoutStatus };
    }

    if (r.outcome === "paid") {
      // Status lookups go by batch id, so one reference cannot serve two payouts.
      if (await isBatchOnAnotherPayout(tx, evidence, payoutId)) {
        throw new Error("That PayPal reference is already on another payout");
      }
    } else {
      await refuseIfMoneyMayHaveLeft(tx, payout);
    }

    const status: PayoutStatus = r.outcome === "paid" ? "succeeded" : "failed";
    // A batch id from PayPal outranks a typed one, which the audit row still keeps.
    const batchId = payout.paypalPayoutBatchId ?? evidence;
    // settle() takes no colony lock, so it can commit after the read above. These
    // guards stop this ruling from overwriting what it wrote.
    const moved = await tx
      .update(payouts)
      .set({
        status,
        ...(r.outcome === "paid" ? { paypalPayoutBatchId: batchId } : {}),
      })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, "needs_review")))
      .returning({ id: payouts.id });
    if (moved.length === 0) {
      const [current] = await tx
        .select({ status: payouts.status })
        .from(payouts)
        .where(eq(payouts.id, payoutId));
      return { ...base, status: current.status as PayoutStatus };
    }
    await tx
      .update(agentActions)
      .set({ status, ...(r.outcome === "paid" ? { paypalRef: batchId } : {}) })
      .where(
        and(eq(agentActions.id, payout.actionId), eq(agentActions.status, "needs_review")),
      );
    await tx.insert(agentActions).values({
      action: "payout_review_resolved",
      inputs: {
        payoutId,
        outcome: r.outcome,
        ...(r.outcome === "paid" ? { paypalRef: evidence } : { note: evidence }),
        previousBatchId: payout.paypalPayoutBatchId,
      },
      reason: r.outcome === "paid" ? "Caretaker confirmed payment" : "Caretaker confirmed no payment",
      amount: payout.amount,
      status,
      approvedBy: caretakerId,
      paypalRef: r.outcome === "paid" ? evidence : null,
    });
    await enqueueStatusChange(tx, payout, status);
    return { ...base, status };
  });
}

/**
 * Why a row cannot get "Allow a new try", or undefined if it can. Only a rejected or failed row that PayPal never
 * saw: no batch id, no BATCH_EXISTS, no late-success pointer, not already cleared.
 */
export function newTryRefusal(p: Pick<Payout, "status" | "attempts" | "paypalPayoutBatchId" | "paypalItemStatus" | "lastGatewayError" | "lateSuccessReviewId" | "retryClearedBy">): string | undefined {
  if (p.status !== "rejected" && p.status !== "failed") return "Only a rejected or failed payout can be given a new try";
  if (p.paypalPayoutBatchId) return "Cannot allow a new try: this payout has a PayPal batch";
  if (mayHaveReachedPayPal(p)) return "Cannot allow a new try: this payout may have reached PayPal";
  if (p.lastGatewayError?.startsWith(BATCH_EXISTS_FLAG)) return "Cannot allow a new try: PayPal reports this batch already exists";
  if (p.lateSuccessReviewId) return "Cannot allow a new try: PayPal reported a success for this payout";
  if (p.retryClearedBy) return "A new try was already allowed for this payout";
  return undefined;
}

/**
 * A caretaker's "Allow a new try" on a rejected or failed row PayPal never saw. The retry block then skips the row,
 * so the agent gets one more try (if that one fails or is rejected, it blocks again). Recorded on the row and as an
 * audit action, and the agent is woken. Moves no money.
 */
export async function allowNewTry(payoutId: string, caretakerId: string, note: string): Promise<GateResult> {
  const clean = note.trim();
  if (!clean) throw new Error("A note is required to allow a new try");
  return withColonyLock(async (tx): Promise<GateResult> => {
    const payout = await loadForDecision(tx, payoutId, caretakerId);
    const [fresh] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update");
    const refusal = newTryRefusal(fresh);
    if (refusal) throw new Error(refusal);
    await tx.update(payouts).set({ retryClearedBy: caretakerId }).where(eq(payouts.id, payoutId));
    await tx.insert(agentActions).values({
      action: "payout_retry_allowed",
      inputs: { payoutId, bookingId: payout.bookingId, kind: payout.kind, previousStatus: payout.status, note: clean },
      reason: "Caretaker allowed one new try",
      amount: payout.amount,
      status: payout.status,
      approvedBy: caretakerId,
    });
    await enqueueStatusChange(tx, payout, payout.status as PayoutStatus, { alert: "retry_allowed" });
    return { payoutId, actionId: payout.actionId, status: payout.status as PayoutStatus };
  });
}

/** PayPal's own words for money that came back after a SUCCESS. */
const LATE_NOT_PAID = new Set(["RETURNED", "REFUNDED", "REVERSED"]);

/** Which rulings a late-success payout may get, from PayPal's latest item status. The desk offers only these. */
export function lateSuccessChoices(itemStatus: string | null): { paid: boolean; notPaid: boolean } {
  return { paid: itemStatus === "SUCCESS", notPaid: LATE_NOT_PAID.has(itemStatus ?? "") };
}

/**
 * A caretaker's ruling on a payout PayPal said succeeded after the fund called it failed. "Paid" makes it succeeded
 * with PayPal's batch id (the books then count it, the pointer stays so it can never be asked for again, and the
 * agent is woken to move on). "Not paid" needs a note, clears the pointer and leaves it failed; a later SUCCESS
 * flags it again. Either way the question is closed. Nothing is ever sent.
 */
async function resolveLateSuccess(
  tx: Tx,
  payout: Payout,
  caretakerId: string,
  r: ReviewResolution,
  evidence: string,
): Promise<GateResult> {
  const base = { payoutId: payout.id, actionId: payout.actionId };
  const paid = r.outcome === "paid";
  // Paid only while PayPal's latest word is SUCCESS, so a later RETURNED is never counted as money paid. Not paid
  // only when PayPal itself says it came back.
  if (paid && payout.paypalItemStatus !== "SUCCESS") {
    throw new Error(`Cannot rule paid: PayPal's latest status for this payout is ${payout.paypalItemStatus ?? "unknown"}, not SUCCESS`);
  }
  if (!paid && !LATE_NOT_PAID.has(payout.paypalItemStatus ?? "")) {
    throw new Error(`Cannot rule not_paid: PayPal's latest status for this payout is ${payout.paypalItemStatus ?? "unknown"}, and it has not said the money came back`);
  }
  if (paid && payout.paypalPayoutBatchId === null && (await isBatchOnAnotherPayout(tx, evidence, payout.id))) {
    throw new Error("That PayPal reference is already on another payout");
  }
  const batchId = payout.paypalPayoutBatchId ?? evidence;
  const moved = await tx
    .update(payouts)
    .set(paid ? { status: "succeeded", paypalPayoutBatchId: batchId } : { lateSuccessReviewId: null })
    .where(and(eq(payouts.id, payout.id), eq(payouts.status, "failed"), isNotNull(payouts.lateSuccessReviewId)))
    .returning({ id: payouts.id });
  if (moved.length === 0) {
    const [current] = await tx.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, payout.id));
    return { ...base, status: current.status as PayoutStatus };
  }
  await tx
    .update(reviewRequests)
    .set({ status: "resolved", resolvedBy: caretakerId, resolvedAt: sql`now()`, resolution: paid ? `Paid: ${evidence}` : `Not paid: ${evidence}` })
    .where(and(eq(reviewRequests.id, payout.lateSuccessReviewId!), eq(reviewRequests.status, "open")));
  if (paid) {
    await tx.update(agentActions).set({ status: "succeeded", paypalRef: batchId }).where(eq(agentActions.id, payout.actionId));
  }
  await tx.insert(agentActions).values({
    action: "payout_review_resolved",
    inputs: { payoutId: payout.id, outcome: r.outcome, late: true, ...(paid ? { paypalRef: evidence } : { note: evidence }), previousBatchId: payout.paypalPayoutBatchId },
    reason: paid ? "Caretaker confirmed payment after a late SUCCESS" : "Caretaker confirmed no payment after a late SUCCESS",
    amount: payout.amount,
    status: paid ? "succeeded" : "failed",
    approvedBy: caretakerId,
    paypalRef: paid ? batchId : null,
  });
  // The agent always hears about it, whichever way it went.
  await enqueueStatusChange(tx, payout, paid ? "succeeded" : "failed", paid ? {} : { alert: "late_success_cleared" });
  return { ...base, status: paid ? "succeeded" : "failed" };
}

function nextStatus(payout: Payout, itemStatus: string | undefined): PayoutStatus | undefined {
  if (!itemStatus) return undefined;
  const target: PayoutStatus | undefined = ITEM_SUCCEEDED.has(itemStatus)
    ? "succeeded"
    : ITEM_FAILED.has(itemStatus)
      ? "failed"
      : ITEM_UNSETTLED.has(itemStatus)
        ? "needs_review"
        : undefined;
  if (!target) return undefined;
  // Already waiting for a person, and PayPal has nothing new to say.
  if (payout.status === "needs_review" && target === "needs_review") return undefined;
  // A real PayPal status settles a review that nobody could settle before.
  if (payout.status === "sent" || payout.status === "needs_review") return target;
  if (payout.status === "succeeded" && ITEM_UNDOES_SUCCESS.has(itemStatus)) return "failed";
  return undefined;
}

const isCentavos = (fee: number | undefined): fee is number =>
  fee !== undefined && Number.isSafeInteger(fee) && fee >= 0;

/** We minted the sender batch id, so it is tried first. It may be any string from outside. */
async function findPayout(
  tx: Tx,
  batchId: string,
  senderBatchId: string | undefined,
): Promise<Payout | undefined> {
  if (senderBatchId) {
    const [bySender] = await tx
      .select()
      .from(payouts)
      .where(sql`${payouts.id}::text = ${senderBatchId}`);
    if (bySender) return bySender;
  }
  const [byBatch] = await tx
    .select()
    .from(payouts)
    .where(eq(payouts.paypalPayoutBatchId, batchId));
  return byBatch;
}

/**
 * A failed payout is terminal and has freed its reservation, so a later SUCCESS would otherwise vanish while the
 * money has left. It stays failed (nobody has checked, and "paid" must be true) and a question goes to the caretaker
 * desk, once per payout. The question's id is kept on the row: while it is open the agent may not ask for this
 * booking and kind again, because a new row would mean a new sender_batch_id and a second payment. The row's
 * last_gateway_error is left alone, so earlier evidence such as BATCH_EXISTS is never overwritten.
 */
async function flagLateSuccess(tx: Tx, payout: Payout, batchId: string, fee: number | undefined): Promise<void> {
  if (payout.lateSuccessReviewId) return;
  console.error(`Payout ${payout.id} is failed but PayPal reports SUCCESS for batch ${batchId}`);
  const [made] = await tx
    .insert(reviewRequests)
    .values({
      subject: "PayPal says a failed payout succeeded",
      reason:
        `Payout ${payout.id} was marked failed, but PayPal now reports SUCCESS for batch ${batchId}. ` +
        `The money may have reached the vet. It still shows as failed and unpaid, and the treasurer may never ask for this payout again, whatever you do with this note. ` +
        `Check it at PayPal, then use "Paid" (the vet was paid: it becomes paid and the books are corrected) or "Not paid" (with a note saying what you checked at PayPal) on the payout under Payouts under review.`,
    })
    .returning({ id: reviewRequests.id });
  // Keep what PayPal told us, so "Paid" can correct the books without anyone retyping it.
  const canStore = payout.paypalPayoutBatchId === null && !(await isBatchOnAnotherPayout(tx, batchId, payout.id));
  await tx
    .update(payouts)
    .set({
      lateSuccessReviewId: made.id,
      ...(canStore ? { paypalPayoutBatchId: batchId } : {}),
      ...(isCentavos(fee) ? { fee } : {}),
    })
    .where(eq(payouts.id, payout.id));
}

/** Idempotent. The wakeup commits with the status change, and only on a real change. */
export async function applyPayoutStatus(batchId: string, u: PayoutStatusUpdate): Promise<void> {
  await withColonyLock((tx) => applyPayoutStatusIn(tx, batchId, u));
}

/** Same as applyPayoutStatus inside the caller's transaction, which must hold the colony lock. */
export async function applyPayoutStatusIn(
  tx: Tx,
  batchId: string,
  u: PayoutStatusUpdate,
): Promise<void> {
  const payout = await findPayout(tx, batchId, u.senderBatchId);
  if (!payout) return;

  if (payout.paypalPayoutBatchId !== batchId) {
    // The sender id and batch id name different payouts, so this event settles neither.
    if (await isBatchOnAnotherPayout(tx, batchId, payout.id)) {
      console.error(`Batch ${batchId} is on another payout, not applying it to ${payout.id}`);
      return;
    }
    if (payout.paypalPayoutBatchId) {
      console.error(`Payout ${payout.id} keeps batch ${payout.paypalPayoutBatchId}, ignoring ${batchId}`);
    }
  }

  // A row whose send has no recorded result gets its real batch id from PayPal.
  const attach =
    payout.paypalPayoutBatchId === null &&
    (payout.status === "queued" || payout.status === "needs_review" || payout.status === "failed");
  const paypalPayoutBatchId = attach ? batchId : payout.paypalPayoutBatchId;
  const status = nextStatus(payout, u.itemStatus);
  // The last thing PayPal said, kept as evidence. A caretaker may rule not_paid on a BLOCKED or REVERSED one.
  if (u.itemStatus && payout.paypalItemStatus !== u.itemStatus) {
    await tx.update(payouts).set({ paypalItemStatus: u.itemStatus }).where(eq(payouts.id, payout.id));
  }
  if (!status && payout.status === "failed" && u.itemStatus === "SUCCESS") {
    await flagLateSuccess(tx, payout, batchId, u.fee);
    return;
  }
  if (!status) {
    if (paypalPayoutBatchId !== payout.paypalPayoutBatchId) {
      await tx.update(payouts).set({ paypalPayoutBatchId }).where(eq(payouts.id, payout.id));
    }
    return;
  }

  await tx
    .update(payouts)
    .set({
      status,
      paypalPayoutBatchId,
      paypalItemId: u.itemId ?? payout.paypalItemId,
      // A bad fee must not cost us the status it came with.
      fee: status === "succeeded" && isCentavos(u.fee) ? u.fee : payout.fee,
    })
    .where(eq(payouts.id, payout.id));
  await tx
    .update(agentActions)
    .set({ status, paypalRef: paypalPayoutBatchId })
    .where(eq(agentActions.id, payout.actionId));
  await enqueueStatusChange(tx, payout, status);
}

/**
 * Polls every sent payout, and every payout under review with a batch id to ask
 * about. A failed row is logged and left for the next run.
 */
export async function reconcilePayouts(gw: PayoutGateway): Promise<void> {
  const rows = await db
    .select({ batchId: payouts.paypalPayoutBatchId })
    .from(payouts)
    .where(
      and(
        inArray(payouts.status, ["sent", "needs_review"]),
        isNotNull(payouts.paypalPayoutBatchId),
      ),
    );

  for (const { batchId } of rows) {
    if (!batchId) continue;
    try {
      const remote = await gw.get(batchId);
      // A dead batch moved no money, unless its item says otherwise.
      const dead = BATCH_DEAD.has(remote.batchStatus) && remote.itemStatus !== "SUCCESS";
      await applyPayoutStatus(batchId, {
        itemStatus: dead ? "FAILED" : remote.itemStatus,
        itemId: remote.itemId,
        fee: remote.fee,
      });
    } catch (e) {
      console.error(`Payout poll failed for batch ${batchId}: ${describeGatewayError(e)}`);
    }
  }
}

/**
 * Sends queued payouts nobody has tried in the last 30 seconds, with the same id:
 * lost responses, senders that crashed, and approved payouts never sent. Measured
 * from the last attempt, since an approved payout's row can be days old while its
 * send is still in flight.
 */
export async function retryUnknownPayouts(gw: PayoutGateway): Promise<void> {
  const stale = await db
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.status, "queued"),
        sql`coalesce(${payouts.lastAttemptAt}, ${payouts.createdAt})
            < now() - make_interval(secs => ${RETRY_AFTER_SECONDS})`,
      ),
    )
    .orderBy(payouts.createdAt);

  for (const payout of stale) {
    try {
      if (payout.attempts >= MAX_ATTEMPTS) {
        // The last sender died before recording a result. Retries are used up.
        await settle(payout, "needs_review", { error: "Retries exhausted" });
      } else {
        await send(payout.id, payout.attempts, gw);
      }
    } catch (e) {
      console.error(`Payout retry failed for ${payout.id}: ${describeGatewayError(e)}`);
    }
  }
}
