import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { CURRENCY } from "@/lib/config";
import { toPayPalValue } from "@/lib/money";
import type { OrdersGateway } from "../paypal/orders";
import type { PayoutBatchStatus, PayoutCreateInput, PayoutCreateResult, PayoutGateway } from "../paypal/payouts";

/*
 * Fake PayPal for the end-to-end test. Stateless, so the web server and the worker agree without sharing
 * memory: an order id carries its amount, and a batch id carries the amount and the sender batch id.
 * Every id starts with E2E- so none can pass for a real PayPal id. The fee model is a stand-in for the
 * sandbox's (about 2.9% plus a fixed fee), not a claim about PayPal's real prices.
 */

export const FAKE_SIGNATURE = "e2e-fake-signature";

/** 2.9% plus PHP 15.00, rounded to the centavo. PHP 100.00 pays PHP 17.90. */
export const fakeDonationFee = (gross: number): number => Math.round(gross * 0.029) + 1500;

/** 2% of the payout, at most PHP 50.00. */
export const fakePayoutFee = (amount: number): number => Math.min(Math.round(amount * 0.02), 5000);

/** One JSON line per call to the fake, when E2E_FAKE_LOG names a file. The test reads it to prove no payment was repeated. */
export function log(entry: Record<string, unknown>): void {
  const file = process.env.E2E_FAKE_LOG;
  if (file) appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export const fakeOrdersGateway: OrdersGateway = {
  async createOrder(amount) {
    const orderId = `E2E-ORDER-${amount}-${randomUUID().slice(0, 8)}`;
    log({ call: "createOrder", orderId, amount });
    return { orderId };
  },
  async captureOrder(orderId) {
    const m = /^E2E-ORDER-(\d+)-([0-9a-f]{8})$/.exec(orderId);
    if (!m) throw new Error("Unknown fake order");
    const gross = Number(m[1]);
    const fee = fakeDonationFee(gross);
    const money = (c: number) => ({ currency_code: CURRENCY, value: toPayPalValue(c) });
    log({ call: "captureOrder", orderId, gross, fee });
    return {
      id: orderId,
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: `E2E-CAPTURE-${m[2]}`,
                status: "COMPLETED",
                amount: money(gross),
                seller_receivable_breakdown: { gross_amount: money(gross), paypal_fee: money(fee), net_amount: money(gross - fee) },
              },
            ],
          },
        },
      ],
    };
  },
};

export const fakePayoutGateway: PayoutGateway = {
  async create(i: PayoutCreateInput): Promise<PayoutCreateResult> {
    // The same sender batch id always gives the same batch, as PayPal's idempotency does.
    const batchId = `E2E-BATCH-${i.amount}-${i.senderBatchId}`;
    log({ call: "payout.create", senderBatchId: i.senderBatchId, batchId, amount: i.amount, receiver: i.receiver });
    return { kind: "sent", batchId, status: "PENDING" };
  },
  async get(batchId: string): Promise<PayoutBatchStatus> {
    const m = /^E2E-BATCH-(\d+)-/.exec(batchId);
    if (!m) throw new Error("Unknown fake batch");
    log({ call: "payout.get", batchId });
    return { batchStatus: "SUCCESS", itemId: `E2E-ITEM-${batchId.slice(-12)}`, itemStatus: "SUCCESS", fee: fakePayoutFee(Number(m[1])) };
  },
};

/** The webhook check in the fake: a call must carry the fake signature and every PayPal header. */
export function fakeVerifyWebhook(headers: Headers): boolean {
  const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-time"];
  return headers.get("paypal-transmission-sig") === FAKE_SIGNATURE && required.every((h) => headers.get(h));
}
