import { readFileSync } from "node:fs";
import { db } from "../../src/server/db/client";
import { donations, users } from "../../src/server/db/schema";
import type { PayPalCapture, RawCapture } from "../../src/server/paypal/orders";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/paypal/order-capture-PHP.json", import.meta.url), "utf8"),
) as { body: { purchase_units: { payments: { captures: RawCapture[] } }[] } };

/** The real sandbox capture: gross 100.00, fee 18.40, net 81.60. */
export const FIXTURE_CAPTURE = fixture.body.purchase_units[0].payments.captures[0];
export const FIXTURE_GROSS = 10_000;
export const FIXTURE_FEE = 1_840;
export const FIXTURE_NET = 8_160;

let seq = 0;

export async function makeDonor() {
  const [u] = await db
    .insert(users)
    .values({ username: `donor_${Date.now()}_${++seq}`, role: "donor" })
    .returning();
  return u;
}

export async function makePendingOrder(userId: string, gross = FIXTURE_GROSS) {
  const orderId = `ORDER-${Date.now()}-${++seq}`;
  const [row] = await db
    .insert(donations)
    .values({ userId, gross, paypalFee: 0, net: 0, paypalOrderId: orderId, status: "pending" })
    .returning();
  return { orderId, row };
}

export function captureFor(orderId: string, patch: Partial<RawCapture> = {}): PayPalCapture {
  return { ...structuredClone(FIXTURE_CAPTURE), ...patch, orderId };
}

/** A PAYMENT.CAPTURE.COMPLETED event body for an order. */
export function captureEvent(eventId: string, orderId: string, patch: Partial<RawCapture> = {}) {
  return {
    id: eventId,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      ...structuredClone(FIXTURE_CAPTURE),
      ...patch,
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  };
}

const money = (centavos: number) => ({
  currency_code: "PHP",
  value: `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`,
});

/**
 * A PAYMENT.CAPTURE.REFUNDED / REVERSED body. The resource is a refund object whose "up" link names the capture,
 * and seller_payable_breakdown holds the amount, the fee PayPal gave back and the net taken from the seller.
 */
export function reversalEvent(
  eventId: string,
  eventType: "PAYMENT.CAPTURE.REFUNDED" | "PAYMENT.CAPTURE.REVERSED" | "PAYMENT.CAPTURE.DENIED",
  o: { refundId: string; captureId?: string; orderId?: string; gross?: number; fee?: number; status?: string; breakdown?: boolean },
) {
  const gross = o.gross ?? FIXTURE_GROSS;
  const fee = o.fee ?? 0;
  const captureId = o.captureId ?? String(FIXTURE_CAPTURE.id);
  return {
    id: eventId,
    event_type: eventType,
    resource: {
      id: o.refundId,
      status: o.status ?? "COMPLETED",
      amount: money(gross),
      ...(o.breakdown === false
        ? {}
        : {
            seller_payable_breakdown: {
              gross_amount: money(gross),
              paypal_fee: money(fee),
              net_amount: money(gross - fee),
              total_refunded_amount: money(gross),
            },
          }),
      links: [
        { rel: "self", href: `https://api.sandbox.paypal.com/v2/payments/refunds/${o.refundId}` },
        { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` },
      ],
      ...(o.orderId ? { supplementary_data: { related_ids: { order_id: o.orderId } } } : {}),
    },
  };
}
