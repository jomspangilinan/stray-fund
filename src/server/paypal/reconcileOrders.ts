import { and, asc, eq, gt, lt, or, isNull, sql } from "drizzle-orm";
import { withColonyLock } from "../db/client";
import { donations } from "../db/schema";
import { describeError } from "../errors";
import { CAPTURED } from "../ledger";
import {
  captureFromOrder,
  ordersGateway,
  PayPalRateLimited,
  PENDING,
  recordCapture,
  type OrdersGateway,
  type PayPalCapture,
} from "./orders";
import { applyCaptureReversal } from "./reversals";

/*
 * Catches a donation whose capture webhook was lost. PayPal retries a failed webhook up to 25 times over 3 days,
 * then marks it Failed (https://developer.paypal.com/api/rest/webhooks/), and the donor may also close the page
 * between approving and our capture call. So the worker asks PayPal about pending orders, and anything captured
 * goes through recordCapture, the same writer the page and the webhook use, which writes once.
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type OrderBody = {
  status?: unknown;
  purchase_units?: { payments?: { refunds?: Record<string, unknown>[] } }[];
};

async function backOff(donationId: string, attempts: number, minutes?: number): Promise<void> {
  const wait = minutes ?? Math.min(BACKOFF_BASE_MINUTES * 2 ** attempts, BACKOFF_MAX_MINUTES);
  await withColonyLock((tx) =>
    tx
      .update(donations)
      .set({
        reconcileAttempts: sql`${donations.reconcileAttempts} + 1`,
        reconcileAfter: sql`now() + make_interval(mins => ${wait})`,
      })
      .where(and(eq(donations.id, donationId), eq(donations.status, PENDING))),
  );
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
 * An order PayPal shows captured is recorded; one the donor approved but nobody captured is captured with the same
 * request id the page uses. A PayPal error, a 429 or an order that is not done yet writes no money: it only spaces
 * out the next question (doubling from 5 minutes up to 6 hours, 15 minutes after a 429, which also ends the batch).
 */
export async function reconcilePendingDonations(
  gw: OrdersGateway = ordersGateway(),
  opts: { batch?: number; paceMs?: number } = {},
): Promise<void> {
  const due = await withColonyLock((tx) =>
    tx
      .select({ id: donations.id, orderId: donations.paypalOrderId, attempts: donations.reconcileAttempts })
      .from(donations)
      .where(
        and(
          eq(donations.status, PENDING),
          lt(donations.createdAt, sql`now() - make_interval(mins => ${MIN_AGE_MINUTES})`),
          gt(donations.createdAt, sql`now() - make_interval(hours => ${MAX_AGE_HOURS})`),
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
      let body = (await gw.getOrder(d.orderId)) as OrderBody & { id?: unknown };
      // The donor said yes and nobody took the money. Capturing is idempotent per order and is what they approved.
      if (body?.status === "APPROVED") body = (await gw.captureOrder(d.orderId)) as typeof body;
      if (body?.status !== "COMPLETED") {
        await backOff(d.id, d.attempts);
        continue;
      }
      if (await record(captureFromOrder(body), body)) continue;
      await backOff(d.id, d.attempts);
    } catch (e) {
      if (e instanceof PayPalRateLimited) {
        console.error("[worker] PayPal rate limit reached, pausing donation checks");
        await backOff(d.id, d.attempts, RATE_LIMIT_WAIT_MINUTES);
        return;
      }
      console.error(`[worker] donation check failed for order ${d.orderId}: ${describeError(e)}`);
      await backOff(d.id, d.attempts);
    }
  }
}
