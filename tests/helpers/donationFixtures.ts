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
