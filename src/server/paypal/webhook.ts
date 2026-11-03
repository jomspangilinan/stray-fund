import { CURRENCY } from "@/lib/config";
import { fromPayPalValue } from "@/lib/money";
import { db, lockColony, type Tx } from "../db/client";
import { e2eFakesEnabled } from "../e2e/guard";
import { fakeVerifyWebhook } from "../e2e/paypal";
import { webhookEvents } from "../db/schema";
import { applyPayoutStatusIn } from "../moneyGate";
import { accessToken, credentials } from "./payouts";
import { recordCapture, UnknownOrder, type RawCapture } from "./orders";
import { applyCaptureReversal, REVERSAL_EVENTS } from "./reversals";

export type WebhookEvent = {
  id: string;
  event_type: string;
  resource?: Record<string, unknown>;
};

const HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

/**
 * Asks PayPal to verify the signature. The raw body is spliced into the request
 * as text, never parsed and reserialized, since any change would break the check.
 * With no PAYPAL_WEBHOOK_ID this refuses everything rather than skipping the check.
 */
export async function verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
  if (e2eFakesEnabled()) return fakeVerifyWebhook(headers);
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error("PAYPAL_WEBHOOK_ID is not set, rejecting webhook");
    return false;
  }
  const meta: Record<string, string> = {};
  for (const [key, header] of Object.entries(HEADERS)) {
    const v = headers.get(header);
    if (!v) return false;
    meta[key] = v;
  }
  const c = credentials();
  const signal = AbortSignal.timeout(30_000);
  const token = await accessToken(c, signal);
  const body = `${JSON.stringify({ ...meta, webhook_id: webhookId }).slice(0, -1)},"webhook_event":${rawBody}}`;
  const res = await fetch(`${c.baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    signal,
  });
  // A 4xx means PayPal did not accept the verification request, so we cannot
  // vouch for the event. 5xx is PayPal's fault and must be retried.
  if (res.status >= 400 && res.status < 500) return false;
  if (!res.ok) throw new Error(`Webhook verification call failed: HTTP ${res.status}`);
  const out = (await res.json()) as { verification_status?: string };
  return out.verification_status === "SUCCESS";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Payouts money uses "currency"; Orders uses "currency_code". Accept both. */
function centavos(m: unknown, what: string): number | undefined {
  const money = m as { currency?: unknown; currency_code?: unknown; value?: unknown } | undefined;
  const currency = money?.currency ?? money?.currency_code;
  if (currency === CURRENCY && typeof money?.value === "string") {
    try {
      return fromPayPalValue(money.value);
    } catch {
      // fall through to the log
    }
  }
  console.error(`Unreadable ${what} on a payout event, recording none`);
  return undefined;
}

/** What each payouts item event means when its resource carries no transaction_status. HELD and UNCLAIMED are not final. */
const ITEM_EVENT_STATUS: Record<string, string> = {
  SUCCEEDED: "SUCCESS",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  CANCELED: "CANCELED",
  REFUNDED: "REFUNDED",
  RETURNED: "RETURNED",
  HELD: "ONHOLD",
  UNCLAIMED: "UNCLAIMED",
};

const itemEventStatus = (suffix: string): string | undefined =>
  Object.hasOwn(ITEM_EVENT_STATUS, suffix) ? ITEM_EVENT_STATUS[suffix] : undefined;

async function applyEvent(tx: Tx, event: WebhookEvent): Promise<void> {
  const r = event.resource ?? {};
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const related = (r.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
    const orderId = str(related?.order_id);
    if (!orderId) {
      console.error(`Capture event ${event.id} has no order id, ignoring`);
      return;
    }
    try {
      await recordCapture({ ...(r as RawCapture), orderId }, tx);
    } catch (e) {
      if (!(e instanceof UnknownOrder)) throw e;
      console.error(`Capture event ${event.id} is for unknown order ${orderId}, ignoring`);
    }
    return;
  }
  const reversal = Object.hasOwn(REVERSAL_EVENTS, event.event_type) ? REVERSAL_EVENTS[event.event_type] : undefined;
  if (reversal) {
    await applyCaptureReversal(tx, reversal, r);
    return;
  }
  if (event.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const batchId = str(r.payout_batch_id);
    if (!batchId) {
      console.error(`Payout event ${event.id} has no batch id, ignoring`);
      return;
    }
    await applyPayoutStatusIn(tx, batchId, {
      itemStatus: str(r.transaction_status) ?? itemEventStatus(event.event_type.slice("PAYMENT.PAYOUTS-ITEM.".length)),
      itemId: str(r.payout_item_id),
      fee: r.payout_item_fee === undefined ? undefined : centavos(r.payout_item_fee, "fee"),
      senderBatchId: str(r.sender_batch_id),
    });
  }
}

/**
 * Dedupes through webhook_events in the same transaction as the effect, so a crash
 * before commit leaves no trace and PayPal's retry runs it again. Unknown types are
 * recorded and acknowledged. Returns "duplicate" for a replayed event id.
 */
export async function handleWebhookEvent(event: WebhookEvent): Promise<"processed" | "duplicate"> {
  return db.transaction(async (tx) => {
    // Payout effects need the colony lock. Take it before anything else so the
    // lock order is the same everywhere.
    if (event.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.") || Object.hasOwn(REVERSAL_EVENTS, event.event_type)) await lockColony(tx);
    const inserted = await tx
      .insert(webhookEvents)
      .values({ paypalEventId: event.id })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return "duplicate";
    await applyEvent(tx, event);
    return "processed";
  });
}
