import { and, eq, isNull, sql } from "drizzle-orm";
import { CURRENCY } from "@/lib/config";
import { formatPeso, fromPayPalValue } from "@/lib/money";
import type { Tx } from "../db/client";
import { donationReversals, donations, reviewRequests } from "../db/schema";
import { CAPTURED, getPoolStatus } from "../ledger";

/*
 * Money PayPal takes back from a captured donation. Sources (developer.paypal.com):
 *  - PAYMENT.CAPTURE.REFUNDED "A merchant refunds a payment capture."
 *  - PAYMENT.CAPTURE.REVERSED "PayPal reverses a payment capture." (the chargeback money event)
 *  - PAYMENT.CAPTURE.DENIED   "A payment capture is denied."
 *  https://developer.paypal.com/api/rest/webhooks/event-names/
 * The refund object (https://developer.paypal.com/api/payments/v2/schema.json) carries seller_payable_breakdown:
 * gross_amount is what the payee refunded, paypal_fee the fee PayPal gave back, and net_amount what the payee's
 * account is debited (gross minus fee minus platform fees). Those are the deltas written here.
 * CUSTOMER.DISPUTE.* events move no money (the reversal does), so they are not acted on.
 */

export type ReversalKind = "refund" | "reversal" | "denied";

export const REVERSAL_EVENTS: Record<string, ReversalKind> = {
  "PAYMENT.CAPTURE.REFUNDED": "refund",
  "PAYMENT.CAPTURE.REVERSED": "reversal",
  "PAYMENT.CAPTURE.DENIED": "denied",
};

/** The refund names a capture or order we have no record of yet. PayPal retries the event, so it lands once the capture is recorded. */
export class UnknownCapture extends Error {
  constructor(what: string) {
    super(`Reversal for ${what} we have no record of yet`);
    this.name = "UnknownCapture";
  }
}

type Money = { currency_code?: unknown; value?: unknown };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function centavos(m: Money | undefined): number | undefined {
  if (!m || m.currency_code !== CURRENCY || typeof m.value !== "string") return undefined;
  try {
    return fromPayPalValue(m.value);
  } catch {
    return undefined;
  }
}

/** PayPal's own numbers, or undefined when they are missing or do not add up. Never guessed. */
function readBreakdown(resource: Record<string, unknown>): { gross: number; fee: number; net: number } | undefined {
  const b = resource.seller_payable_breakdown as Record<string, Money> | undefined;
  if (!b) return undefined;
  const gross = centavos(b.gross_amount);
  const net = centavos(b.net_amount);
  // A refund PayPal gives no fee for gave none back.
  const fee = b.paypal_fee === undefined ? 0 : centavos(b.paypal_fee);
  if (gross === undefined || net === undefined || fee === undefined || gross !== fee + net) return undefined;
  return { gross, fee, net };
}

function captureIdOf(kind: ReversalKind, resource: Record<string, unknown>): string | undefined {
  // A denial is about the capture itself.
  if (kind === "denied") return str(resource.id);
  const links = Array.isArray(resource.links) ? (resource.links as { rel?: unknown; href?: unknown }[]) : [];
  const up = links.find((l) => l?.rel === "up" && typeof l.href === "string");
  return /\/v2\/payments\/captures\/([A-Za-z0-9_-]+)\/?(?:[?#]|$)/.exec(String(up?.href))?.[1];
}

/** A question for the caretaker desk, once per distinct reason while it is open. */
export async function askCaretaker(tx: Tx, subject: string, reason: string): Promise<string> {
  const [open] = await tx
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.reason, reason), eq(reviewRequests.status, "open")));
  if (open) return open.id;
  const [made] = await tx.insert(reviewRequests).values({ subject, reason }).returning({ id: reviewRequests.id });
  return made.id;
}

/**
 * If the pool is below zero, opens a question for each reversal of this donation that has none yet and
 * attaches it. Nothing is taken back and nothing is hidden; new funding already refuses on a short pool.
 * Caller holds the colony lock.
 */
export async function askIfPoolShort(tx: Tx, donationId: string): Promise<void> {
  const [row] = await tx.select({ status: donations.status }).from(donations).where(eq(donations.id, donationId));
  if (row?.status !== CAPTURED) return;
  const open = await tx
    .select()
    .from(donationReversals)
    .where(and(eq(donationReversals.donationId, donationId), isNull(donationReversals.reviewRequestId)));
  if (open.length === 0) return;
  const pool = await getPoolStatus(tx);
  if (pool.available >= 0) return;
  for (const r of open) {
    const id = await askCaretaker(
      tx,
      "PayPal took money back and the pool is short",
      `PayPal ${r.kind === "refund" ? "refunded" : r.kind === "reversal" ? "reversed" : "denied"} ${formatPeso(-r.grossDelta)} ` +
        `(${r.paypalRef}). That money was already given to cats or paid out, so the pool is now ${formatPeso(pool.available)}. ` +
        `Nothing was taken back. New funding stays refused until donations cover the gap.`,
    );
    await tx.update(donationReversals).set({ reviewRequestId: id }).where(eq(donationReversals.id, r.id));
  }
}

/**
 * Applies one refund, reversal or denial. Idempotent on PayPal's id for it, so a replayed event, the same
 * refund under a new event id, or a poll that sees it again changes nothing. Caller holds the colony lock.
 */
export async function applyCaptureReversal(tx: Tx, kind: ReversalKind, resource: Record<string, unknown>): Promise<void> {
  const ref = str(resource.id);
  if (!ref) {
    console.error(`${kind} event has no id, ignoring`);
    return;
  }
  // A refund still pending or failed moved no money. The same refund completing later has the same id.
  if (kind !== "denied" && resource.status !== undefined && resource.status !== "COMPLETED") {
    console.error(`${kind} ${ref} is ${String(resource.status)}, not applying it yet`);
    return;
  }

  const captureId = captureIdOf(kind, resource);
  const related = (resource.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
  const orderId = str(related?.order_id);
  if (!captureId && !orderId) throw new UnknownCapture(`${kind} ${ref}`);

  // Locked, so a capture of this donation committing at the same moment waits, or is waited for, and neither misses the other.
  let [donation] = captureId ? await tx.select().from(donations).where(eq(donations.paypalCaptureId, captureId)).for("update") : [];
  if (!donation && orderId) [donation] = await tx.select().from(donations).where(eq(donations.paypalOrderId, orderId)).for("update");
  if (!donation) throw new UnknownCapture(`${kind} ${ref} on ${captureId ?? orderId}`);

  const [seen] = await tx.select({ id: donationReversals.id }).from(donationReversals).where(eq(donationReversals.paypalRef, ref));
  if (seen) return;

  const prior = (
    await tx
      .select({
        gross: sql<number>`coalesce(sum(${donationReversals.grossDelta}), 0)::int`,
        fee: sql<number>`coalesce(sum(${donationReversals.feeDelta}), 0)::int`,
        net: sql<number>`coalesce(sum(${donationReversals.netDelta}), 0)::int`,
      })
      .from(donationReversals)
      .where(eq(donationReversals.donationId, donation.id))
  )[0];
  const isCaptured = donation.status === CAPTURED;

  let amounts: { gross: number; fee: number; net: number } | undefined;
  let basis: "breakdown" | "remaining" = "breakdown";
  const given = readBreakdown(resource);
  if (given) {
    amounts = given;
  } else if (kind !== "refund") {
    // A chargeback or denial takes the whole capture. With no numbers from PayPal, take what is left in net.
    if (!isCaptured) {
      if (kind === "denied") return; // Never captured here, so nothing was ever counted.
      throw new UnknownCapture(`${kind} ${ref} before its capture`);
    }
    const left = donation.net + prior.net;
    if (left <= 0) return;
    amounts = { gross: left, fee: 0, net: left };
    basis = "remaining";
  }

  const subject = "PayPal sent a refund the fund could not apply";
  if (!amounts) {
    await askCaretaker(tx, subject, `${kind} ${ref} on ${donation.paypalOrderId} has no readable amount. Nothing was recorded. Check it at PayPal.`);
    return;
  }
  // Only gross is capped. PayPal says a refunded fee "might not match the PayPal fee that the payee paid", so a
  // full refund can debit more net than the donation brought in. That loss is real and the pool shows it.
  const tooMuch = prior.gross - amounts.gross < -donation.gross;
  if (tooMuch) {
    await askCaretaker(
      tx,
      subject,
      `${kind} ${ref} on ${donation.paypalOrderId} is more than the donation still holds. Nothing was recorded. Check it at PayPal.`,
    );
    return;
  }

  const [made] = await tx
    .insert(donationReversals)
    .values({
      donationId: donation.id,
      kind,
      paypalRef: ref,
      grossDelta: -amounts.gross,
      feeDelta: -amounts.fee,
      netDelta: -amounts.net,
      basis,
    })
    .onConflictDoNothing()
    .returning({ id: donationReversals.id });
  if (!made) return;
  await askIfPoolShort(tx, donation.id);
}
