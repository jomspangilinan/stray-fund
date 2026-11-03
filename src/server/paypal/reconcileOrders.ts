import { and, asc, eq, gt, lt, or, isNull, sql } from "drizzle-orm";
import { withColonyLock } from "../db/client";
import { donations } from "../db/schema";
import { describeError } from "../errors";
import { CAPTURED } from "../ledger";
import {
  captureFromOrder,
  ordersGateway,
  OrderNotFound,
  PayPalRateLimited,
  PENDING,
  recordCapture,
  type OrdersGateway,
  type PayPalCapture,
} from "./orders";
import { applyCaptureReversal, askCaretaker } from "./reversals";

/*
 * Catches a donation whose capture webhook was lost. PayPal retries a failed webhook up to 25 times over 3 days,
 * then marks it Failed (https://developer.paypal.com/api/rest/webhooks/). So the worker asks PayPal about pending
 * orders, and an order PayPal reports COMPLETED goes through recordCapture, the same writer the page and the webhook
 * use, which writes once.
 *
 * Record only. The worker never captures. An APPROVED order may be one the page told the donor had failed, who then
 * paid on a second order; capturing it here would charge them twice for one intent. Only the donor's own tap captures.
 *
 * Money PayPal holds must not leave the ledger quietly: a COMPLETED order that will not record, or a row that ages
 * out with its last check unresolved, opens one caretaker question.
 */

/** Younger than this, the page's own capture call or the webhook is still on its way. */
export const MIN_AGE_MINUTES = 5;
/** Orders lapse after 6 hours unapproved (up to 72 on request). Older than that, nothing can still be captured. */
export const MAX_AGE_HOURS = 72;
const DEFAULT_BATCH = 10;
/** A gap between PayPal calls, well inside the sandbox rate limit. */
const DEFAULT_PACE_MS = 300;
const BACKOFF_BASE_MINUTES = 5;
const BACKOFF_MAX_MINUTES = 6 * 60;
const RATE_LIMIT_WAIT_MINUTES = 15;

/** Last check left it open: PayPal erred, or the order is approved or its capture pending. Money may be out there. */
const UNRESOLVED = "unresolved";
/** PayPal says the order is VOIDED or does not exist. Nothing to find, never asked again. */
const CLOSED = "closed";
/** A caretaker question was opened. Never asked about or escalated again. */
const ESCALATED = "escalated";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type OrderBody = {
  status?: unknown;
  purchase_units?: { payments?: { refunds?: Record<string, unknown>[] } }[];
};

async function backOff(donationId: string, attempts: number, state: string | null, minutes?: number): Promise<void> {
  const wait = minutes ?? Math.min(BACKOFF_BASE_MINUTES * 2 ** attempts, BACKOFF_MAX_MINUTES);
  await withColonyLock((tx) =>
    tx
      .update(donations)
      .set({
        reconcileAttempts: sql`${donations.reconcileAttempts} + 1`,
        reconcileAfter: sql`now() + make_interval(mins => ${wait})`,
        reconcileState: state,
      })
      .where(and(eq(donations.id, donationId), eq(donations.status, PENDING))),
  );
}

async function setState(donationId: string, state: string): Promise<void> {
  await withColonyLock((tx) =>
    tx.update(donations).set({ reconcileState: state }).where(and(eq(donations.id, donationId), eq(donations.status, PENDING))),
  );
}

/** The question and the escalated mark commit together, so it is asked once. */
async function escalate(donationId: string, orderId: string, why: string): Promise<void> {
  await withColonyLock(async (tx) => {
    const done = await tx
      .update(donations)
      .set({ reconcileState: ESCALATED })
      .where(and(eq(donations.id, donationId), eq(donations.status, PENDING), sql`${donations.reconcileState} is distinct from ${ESCALATED}`))
      .returning({ id: donations.id });
    if (done.length === 0) return;
    await askCaretaker(
      tx,
      "A PayPal donation is not in the ledger",
      `Order ${orderId}: ${why} It is not counted in the pool or the Proof line. Check it at PayPal and record it by hand if the money arrived.`,
    );
  });
}

/** Records the capture and any refunds PayPal lists with it, in one transaction. */
async function record(capture: PayPalCapture, body: OrderBody): Promise<boolean> {
  return withColonyLock(async (tx) => {
    const donation = await recordCapture(capture, tx);
    if (donation.status !== CAPTURED) return false;
    for (const refund of body.purchase_units?.[0]?.payments?.refunds ?? []) {
      // The refund names its order here, since the order is how we found it.
      await applyCaptureReversal(tx, "refund", {
        ...refund,
        supplementary_data: { related_ids: { order_id: capture.orderId } },
      });
    }
    return true;
  });
}

/**
 * Asks PayPal about pending donations between 5 minutes and 72 hours old, one bounded batch, oldest wait first.
 * An order PayPal shows COMPLETED is recorded; nothing is ever captured. A PayPal error, a 429 or an order that is
 * not done yet writes no money: it only spaces out the next question (doubling from 5 minutes up to 6 hours,
 * 15 minutes after a 429, which also ends the batch). VOIDED and 404 are final and stop the polling. A COMPLETED
 * order that will not record, and a row that ages out with its last check unresolved, open one caretaker question.
 */
export async function reconcilePendingDonations(
  gw: OrdersGateway = ordersGateway(),
  opts: { batch?: number; paceMs?: number } = {},
): Promise<void> {
  await escalateAgedOut();
  const due = await withColonyLock((tx) =>
    tx
      .select({ id: donations.id, orderId: donations.paypalOrderId, attempts: donations.reconcileAttempts })
      .from(donations)
      .where(
        and(
          eq(donations.status, PENDING),
          lt(donations.createdAt, sql`now() - make_interval(mins => ${MIN_AGE_MINUTES})`),
          gt(donations.createdAt, sql`now() - make_interval(hours => ${MAX_AGE_HOURS})`),
          sql`${donations.reconcileState} is distinct from ${CLOSED}`,
          sql`${donations.reconcileState} is distinct from ${ESCALATED}`,
          or(isNull(donations.reconcileAfter), lt(donations.reconcileAfter, sql`now()`)),
        ),
      )
      .orderBy(asc(sql`coalesce(${donations.reconcileAfter}, ${donations.createdAt})`), asc(donations.id))
      .limit(opts.batch ?? DEFAULT_BATCH),
  );

  let first = true;
  for (const d of due) {
    if (!first) await sleep(opts.paceMs ?? DEFAULT_PACE_MS);
    first = false;
    try {
      const body = (await gw.getOrder(d.orderId)) as OrderBody & { id?: unknown };
      if (body?.status === "VOIDED") {
        await setState(d.id, CLOSED);
        continue;
      }
      if (body?.status !== "COMPLETED") {
        // CREATED and the like: no money yet, and the order lapses by itself. APPROVED or a pending capture could
        // still become money, so those stay open for the aged-out question.
        const open = body?.status === "APPROVED" || body?.status === "PAYER_ACTION_REQUIRED" ? UNRESOLVED : null;
        await backOff(d.id, d.attempts, open);
        continue;
      }
      let recorded = false;
      try {
        recorded = await record(captureFromOrder(body), body);
      } catch (e) {
        console.error(`[worker] order ${d.orderId} is COMPLETED at PayPal but cannot be recorded: ${describeError(e)}`);
        await escalate(d.id, d.orderId, `PayPal says it is COMPLETED but it could not be recorded (${describeError(e)}).`);
        continue;
      }
      if (recorded) continue;
      // COMPLETED, but the capture itself is not (pending, declined): ask again later.
      await backOff(d.id, d.attempts, UNRESOLVED);
    } catch (e) {
      if (e instanceof PayPalRateLimited) {
        console.error("[worker] PayPal rate limit reached, ending this donation check batch and trying again later");
        await backOff(d.id, d.attempts, UNRESOLVED, RATE_LIMIT_WAIT_MINUTES);
        return;
      }
      if (e instanceof OrderNotFound) {
        await setState(d.id, CLOSED);
        continue;
      }
      console.error(`[worker] donation check failed for order ${d.orderId}: ${describeError(e)}`);
      await backOff(d.id, d.attempts, UNRESOLVED);
    }
  }
}

/** A row past the 72 hour window whose last check left money possibly out there. Asked once, then marked. */
async function escalateAgedOut(): Promise<void> {
  const aged = await withColonyLock((tx) =>
    tx
      .select({ id: donations.id, orderId: donations.paypalOrderId })
      .from(donations)
      .where(
        and(
          eq(donations.status, PENDING),
          eq(donations.reconcileState, UNRESOLVED),
          lt(donations.createdAt, sql`now() - make_interval(hours => ${MAX_AGE_HOURS})`),
        ),
      )
      .limit(50),
  );
  for (const d of aged) {
    await escalate(d.id, d.orderId, `It is still pending after ${MAX_AGE_HOURS} hours and the last check at PayPal was not conclusive.`);
  }
}
