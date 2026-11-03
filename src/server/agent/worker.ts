import { and, eq, sql } from "drizzle-orm";
import { syncCatForPayout } from "../catTransitions";
import { retryPendingSightings } from "../catch";
import { db, type Tx } from "../db/client";
import { wakeups } from "../db/schema";
import { describeError } from "../errors";
import { reconcilePayouts, retryUnknownPayouts } from "../moneyGate";
import { restPayoutGateway } from "../paypal/payouts";
import { isUuid } from "../public";
import { fileReview } from "./review";
import { payoutRetryBlocked } from "./tools";
import {
  eventNeedsPerson,
  runAgent,
  wakeupEvents,
  type AgentDeps,
  type AgentResult,
  type AgentStop,
  type WakeupEvent,
} from "./run";

export const MAX_WAKEUP_ATTEMPTS = 3;
const STALE_AFTER_MINUTES = 10;
const POLL_MS = 3_000;
const MAINTENANCE_MS = 60_000;
/** Before the second and third attempts. */
const BACKOFF_SECONDS = [30, 120];

export type Wakeup = typeof wakeups.$inferSelect;

export type WorkerDeps = AgentDeps & {
  reconcile?: () => Promise<unknown>;
  retryUnknown?: () => Promise<unknown>;
  retrySightings?: () => Promise<unknown>;
  /** Replaces the poll in a test. */
  tick?: () => Promise<unknown>;
};

const claimable = sql`attempts < ${MAX_WAKEUP_ATTEMPTS} and (
  (status = 'pending' and run_after <= now())
  or (status = 'running' and claimed_at < now() - make_interval(mins => ${STALE_AFTER_MINUTES}))
)`;

type Absorbed = { absorbed?: unknown[] };

const payloadObject = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};

/** One event per absorbed wakeup, flattening any that had absorbed others on an earlier try. */
function flatten(payload: unknown): unknown[] {
  const { absorbed, ...own } = payloadObject(payload) as Absorbed & Record<string, unknown>;
  return [own, ...(Array.isArray(absorbed) ? absorbed : [])];
}

/**
 * Claims the oldest due wakeup and commits it as running. A run sees all current state,
 * so other pending wakeups of the same kind are folded into it and marked done, with
 * their facts kept on the claimed row so a retry or a crash cannot lose an alert.
 * Skip-locked on both reads, so two workers can neither double claim nor deadlock.
 */
export async function claimNextWakeup(): Promise<Wakeup | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      select id, kind, payload from wakeups
      where ${claimable}
      order by created_at asc, id asc
      for update skip locked
      limit 1
    `);
    const candidate = rows[0] as { id: string; kind: string; payload: unknown } | undefined;
    if (!candidate) return null;

    const { rows: absorbedRows } = await tx.execute(sql`
      update wakeups set status = 'done'
      where id in (
        select id from wakeups
        where kind = ${candidate.kind} and status = 'pending' and id <> ${candidate.id}
        for update skip locked
      )
      returning payload
    `);

    const payload = payloadObject(candidate.payload);
    const carried = Array.isArray(payload.absorbed) ? payload.absorbed : [];
    const fresh = (absorbedRows as { payload: unknown }[]).flatMap((r) => flatten(r.payload));
    const absorbed = [...carried, ...fresh];

    const [claimed] = await tx
      .update(wakeups)
      .set({
        status: "running",
        attempts: sql`${wakeups.attempts} + 1`,
        claimedAt: sql`now()`,
        ...(absorbed.length > 0 ? { payload: { ...payload, absorbed } } : {}),
      })
      .where(eq(wakeups.id, candidate.id))
      .returning();
    return claimed;
  });
}

const giveUpSubject = (kind: string) => `The treasurer could not finish: ${kind}`;

async function markFailed(tx: Tx, w: Pick<Wakeup, "id" | "kind">, detail: string): Promise<void> {
  await tx.update(wakeups).set({ status: "failed" }).where(eq(wakeups.id, w.id));
  await fileReview(tx, giveUpSubject(w.kind), detail);
}

/** A crashed run with no attempts left is never claimable again, so it is closed out here. */
export async function failStaleWakeups(): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      select id, kind from wakeups
      where status = 'running' and attempts >= ${MAX_WAKEUP_ATTEMPTS}
        and claimed_at < now() - make_interval(mins => ${STALE_AFTER_MINUTES})
      for update skip locked
    `);
    for (const w of rows as { id: string; kind: string }[]) {
      await markFailed(tx, w, "A run stopped part way on its last try. Please check what it was doing.");
    }
  });
}

/** Guards every write back, in case this run outlived its claim and another worker took over. */
const stillMine = (w: Wakeup) =>
  and(eq(wakeups.id, w.id), eq(wakeups.status, "running"), eq(wakeups.attempts, w.attempts));

async function markDone(w: Wakeup): Promise<void> {
  await db.update(wakeups).set({ status: "done" }).where(stillMine(w));
}

async function retryOrFail(w: Wakeup, why: string, opts: { final?: boolean } = {}): Promise<void> {
  if (opts.final || w.attempts >= MAX_WAKEUP_ATTEMPTS) {
    await db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: wakeups.id }).from(wakeups).where(stillMine(w)).for("update");
      if (owned) await markFailed(tx, w, `It stopped after ${w.attempts} tries. Last result: ${why}.`);
    });
    return;
  }
  const delay = BACKOFF_SECONDS[w.attempts - 1] ?? BACKOFF_SECONDS.at(-1)!;
  await db
    .update(wakeups)
    .set({ status: "pending", runAfter: sql`now() + make_interval(secs => ${delay})` })
    .where(stillMine(w));
}

/** Runs in code before the model, so the cat's state never rests on the model's choices. */
async function syncPayouts(w: Wakeup, deps: WorkerDeps): Promise<boolean> {
  if (w.kind !== "payout_status_changed") return true;
  const sync = deps.syncCat ?? syncCatForPayout;
  let ok = true;
  for (const event of wakeupEvents(w)) {
    const id = event.payoutId;
    if (typeof id !== "string" || !isUuid(id)) continue;
    try {
      await sync(id);
    } catch (e) {
      ok = false;
      console.error(`[worker] cat sync failed for payout ${id}: ${describeError(e)}`);
    }
  }
  return ok;
}

/** A failed payout the agent may not try again, read after the run since the run may have used the retry. */
async function failureOutOfRetries(event: WakeupEvent): Promise<boolean> {
  const { status, bookingId, kind } = event;
  if (status !== "failed" || typeof bookingId !== "string" || !isUuid(bookingId)) return false;
  if (kind !== "deposit" && kind !== "balance") return false;
  return payoutRetryBlocked(bookingId, kind);
}

/**
 * A person hears about these whatever the model did, even if the run threw. Repeats
 * on a retry or from a later run merge into the open request with the same subject.
 */
async function ensureReviewFiled(w: Wakeup): Promise<void> {
  const reviews: { subject: string; reason: string }[] = [];
  for (const event of wakeupEvents(w)) {
    const subject = `Payout ${event.payoutId ?? "unknown"} needs a person`;
    if (eventNeedsPerson(event)) {
      reviews.push({
        subject,
        reason: "A vet payment could not be settled automatically, so money may have left. Please check it in PayPal.",
      });
    } else if (await failureOutOfRetries(event)) {
      reviews.push({
        subject,
        reason: "A vet payment failed and the treasurer may not try it again, so the vet is still unpaid. Please check it.",
      });
    }
  }
  if (reviews.length === 0) return;
  await db.transaction(async (tx) => {
    for (const { subject, reason } of reviews) await fileReview(tx, subject, reason);
  });
}

const RETRYABLE_STOPS: readonly AgentStop[] = ["max_tokens", "max_iterations", "budget", "tool_failure", "other"];

/**
 * Handles one claimed wakeup. A refusal would only repeat, so it goes straight to a
 * person. Every other incomplete stop retries, which is safe because a new run reads
 * current state and funding and payouts are each guarded against doing it twice.
 */
export async function processWakeup(w: Wakeup, deps: WorkerDeps = {}): Promise<void> {
  const synced = await syncPayouts(w, deps);

  let result: AgentResult | undefined;
  try {
    result = await runAgent(w, deps);
  } catch (e) {
    console.error(`[worker] run failed for ${w.kind} ${w.id}: ${describeError(e)}`);
  }

  let reviewFiled = true;
  try {
    await ensureReviewFiled(w);
  } catch (e) {
    reviewFiled = false;
    console.error(`[worker] could not file a review for ${w.id}: ${describeError(e)}`);
  }

  if (!result) {
    await retryOrFail(w, "the model could not be reached");
    return;
  }
  console.log(
    `[worker] ${w.kind} ${w.id} attempt ${w.attempts}: stop=${result.stop} actions=${result.actions.join(",") || "none"} tokens=${result.usage.input}/${result.usage.output}`,
  );

  if (!reviewFiled) {
    await retryOrFail(w, "a review could not be filed");
  } else if (result.stop === "refusal") {
    await retryOrFail(w, "the model declined", { final: true });
  } else if (RETRYABLE_STOPS.includes(result.stop)) {
    await retryOrFail(w, result.stop.replaceAll("_", " "));
  } else if (!synced) {
    await retryOrFail(w, "the cat's status could not be updated");
  } else {
    await markDone(w);
  }
}

/** Returns whether a wakeup was handled. */
export async function processNextWakeup(deps: WorkerDeps = {}): Promise<boolean> {
  await failStaleWakeups();
  const w = await claimNextWakeup();
  if (!w) return false;
  await processWakeup(w, deps);
  return true;
}

async function isolated(name: string, job: () => Promise<unknown>): Promise<void> {
  try {
    await job();
  } catch (e) {
    console.error(`[worker] ${name} failed: ${describeError(e)}`);
  }
}

/** Each job is isolated, so one failing never stops the others. */
export async function runMaintenance(deps: WorkerDeps = {}): Promise<void> {
  const gateway = deps.gateway ?? restPayoutGateway;
  await isolated("reconcile", deps.reconcile ?? (() => reconcilePayouts(gateway)));
  await isolated("payout retry", deps.retryUnknown ?? (() => retryUnknownPayouts(gateway)));
  await isolated("sighting retry", deps.retrySightings ?? retryPendingSightings);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

async function everyInterval(name: string, ms: number, signal: AbortSignal, job: () => Promise<unknown>) {
  while (!signal.aborted) {
    await isolated(name, job);
    await sleep(ms, signal);
  }
}

/**
 * Polls and maintains until the signal fires. The signal stops new work only: it never
 * reaches a model call, so the wakeup in hand finishes before this resolves.
 */
export async function runWorkerLoops(
  deps: WorkerDeps,
  stop: AbortSignal,
  timing: { pollMs?: number; maintenanceMs?: number } = {},
): Promise<void> {
  await Promise.all([
    everyInterval("poll", timing.pollMs ?? POLL_MS, stop, deps.tick ?? (() => processNextWakeup(deps))),
    everyInterval("maintenance", timing.maintenanceMs ?? MAINTENANCE_MS, stop, () => runMaintenance(deps)),
  ]);
}
