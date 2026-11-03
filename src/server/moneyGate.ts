import { and, eq, sql } from "drizzle-orm";
import { db, withColonyLock, type Tx } from "./db/client";
import { agentActions, payouts, users, wakeups } from "./db/schema";
import { checkSpend, type GuardrailCode, type SpendRequest } from "./guardrails";
import type { PayoutCreateResult, PayoutGateway } from "./paypal/payouts";

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

export type PayoutStatusUpdate = { itemStatus?: string; itemId?: string; fee?: number };

type Payout = typeof payouts.$inferSelect;

/** The original send plus five retries. */
const MAX_ATTEMPTS = 6;
const RETRY_AFTER_SECONDS = 30;
const LIVE_PAYOUT_INDEX = "payouts_booking_kind_live_idx";

const ITEM_SUCCEEDED = new Set(["SUCCESS"]);
const ITEM_FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "CANCELED"]);
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
    inputs: { ...r.inputs, code },
    reason: r.reason,
    amount: r.amount,
    status: "denied",
  };
}

async function currentStatus(payoutId: string): Promise<PayoutStatus> {
  const [row] = await db
    .select({ status: payouts.status })
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  return row.status as PayoutStatus;
}

/**
 * Commits a queued payout's move to its next status, unless a newer attempt has
 * started or the row has moved on. Returns the status the row ends up in.
 */
async function settle(
  payout: Payout,
  status: "sent" | "failed" | "needs_review",
  fields: { batchId?: string; error?: string },
): Promise<PayoutStatus> {
  const moved = await db.transaction(async (tx) => {
    const rows = await tx
      .update(payouts)
      .set({ status, paypalPayoutBatchId: fields.batchId })
      .where(
        and(
          eq(payouts.id, payout.id),
          eq(payouts.status, "queued"),
          // A batch id is good news from any attempt. Bad news only counts from the latest.
          status === "sent" ? undefined : eq(payouts.attempts, payout.attempts),
        ),
      )
      .returning({ id: payouts.id });
    if (rows.length === 0) return false;
    await tx
      .update(agentActions)
      .set({
        status,
        paypalRef: fields.batchId,
        ...(fields.error ? { inputs: mergedInputs({ gatewayError: fields.error }) } : {}),
      })
      .where(eq(agentActions.id, payout.actionId));
    return true;
  });
  return moved ? status : currentStatus(payout.id);
}

function applyCreateResult(payout: Payout, result: PayoutCreateResult): Promise<PayoutStatus> {
  switch (result.kind) {
    case "sent":
      return settle(payout, "sent", { batchId: result.batchId });
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
      return Promise.resolve("queued");
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
      return { ...base, status: "rejected", code: verdict.code, message: verdict.message };
    }

    await tx.update(payouts).set({ status: "queued" }).where(eq(payouts.id, payoutId));
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
    return { ...base, status: "rejected" };
  });
}

function nextStatus(payout: Payout, itemStatus: string | undefined): PayoutStatus | undefined {
  if (!itemStatus) return undefined;
  const target = ITEM_SUCCEEDED.has(itemStatus)
    ? "succeeded"
    : ITEM_FAILED.has(itemStatus)
      ? "failed"
      : undefined;
  if (!target) return undefined;
  if (payout.status === "sent") return target;
  if (payout.status === "succeeded" && ITEM_UNDOES_SUCCESS.has(itemStatus)) return "failed";
  return undefined;
}

/** Idempotent. The wakeup commits with the status change, and only on a real change. */
export async function applyPayoutStatus(batchId: string, u: PayoutStatusUpdate): Promise<void> {
  await withColonyLock(async (tx) => {
    const [payout] = await tx
      .select()
      .from(payouts)
      .where(eq(payouts.paypalPayoutBatchId, batchId));
    if (!payout) return;
    const status = nextStatus(payout, u.itemStatus);
    if (!status) return;

    await tx
      .update(payouts)
      .set({
        status,
        paypalItemId: u.itemId ?? payout.paypalItemId,
        fee: status === "succeeded" ? (u.fee ?? payout.fee) : payout.fee,
      })
      .where(eq(payouts.id, payout.id));
    await tx
      .update(agentActions)
      .set({ status })
      .where(eq(agentActions.id, payout.actionId));
    await tx.insert(wakeups).values({
      kind: "payout_status_changed",
      payload: {
        payoutId: payout.id,
        catId: payout.catId,
        bookingId: payout.bookingId,
        kind: payout.kind,
        status,
        previousStatus: payout.status,
      },
    });
  });
}

/** Polls every sent payout. A failed poll is left for the next run. */
export async function reconcilePayouts(gw: PayoutGateway): Promise<void> {
  const sent = await db
    .select({ batchId: payouts.paypalPayoutBatchId })
    .from(payouts)
    .where(eq(payouts.status, "sent"));

  for (const { batchId } of sent) {
    if (!batchId) continue;
    let remote: Awaited<ReturnType<PayoutGateway["get"]>>;
    try {
      remote = await gw.get(batchId);
    } catch {
      continue;
    }
    // A dead batch moved no money, unless its item says otherwise.
    const dead = BATCH_DEAD.has(remote.batchStatus) && remote.itemStatus !== "SUCCESS";
    await applyPayoutStatus(batchId, {
      itemStatus: dead ? "FAILED" : remote.itemStatus,
      itemId: remote.itemId,
      fee: remote.fee,
    });
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
    if (payout.attempts >= MAX_ATTEMPTS) {
      // The last sender died before recording a result. Retries are used up.
      await settle(payout, "needs_review", { error: "Retries exhausted" });
    } else {
      await send(payout.id, payout.attempts, gw);
    }
  }
}
