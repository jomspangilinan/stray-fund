import { CURRENCY } from "@/lib/config";
import { fromPayPalValue, toPayPalValue } from "@/lib/money";
import { e2eFakesEnabled } from "../e2e/guard";
import { fakePayoutGateway } from "../e2e/paypal";

export type PayoutCreateInput = {
  /** Always the payout row id. PayPal treats it as the idempotency key. */
  senderBatchId: string;
  receiver: string;
  /** Integer centavos. Converted to a decimal string only in this file. */
  amount: number;
  note: string;
};

export type PayoutCreateResult =
  | { kind: "sent"; batchId: string; status: string }
  /** The money may or may not have left. Retry with the same id, never a new one. */
  | { kind: "unknown"; error: string }
  /** PayPal refused the request. On a retry this can mean it already has the batch. */
  | { kind: "rejected"; error: string }
  /** PayPal already has a batch with this sender id, so this call paid nothing new. */
  | { kind: "duplicate"; batchId?: string; error: string };

export type PayoutBatchStatus = {
  batchStatus: string;
  itemId?: string;
  itemStatus?: string;
  /** Integer centavos. */
  fee?: number;
};

export interface PayoutGateway {
  create(i: PayoutCreateInput): Promise<PayoutCreateResult>;
  get(batchId: string): Promise<PayoutBatchStatus>;
}

const TIMEOUT_MS = 30_000;
/** Timeout, conflict and rate limit responses do not prove the batch was refused. */
const AMBIGUOUS_4XX = new Set([408, 409, 429]);
/** Treat a token as expired this long before PayPal would. */
const TOKEN_MARGIN_MS = 60_000;

export type Credentials = { clientId: string; clientSecret: string; baseUrl: string };

/** An error whose message is known to hold no secrets or personal data. */
class SafeGatewayError extends Error {}

/** Read at call time so importing this file needs no configuration. */
export function credentials(): Credentials {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new SafeGatewayError("PayPal credentials are not set");
  }
  const baseUrl =
    process.env.PAYPAL_ENV === "production"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  return { clientId, clientSecret, baseUrl };
}

let cachedToken: { key: string; token: string; expiresAt: number } | undefined;

export function clearPayPalTokenCache(): void {
  cachedToken = undefined;
}

export async function accessToken(c: Credentials, signal: AbortSignal): Promise<string> {
  const key = `${c.baseUrl}|${c.clientId}|${c.clientSecret}`;
  if (cachedToken?.key === key && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await fetch(`${c.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal,
  });
  if (!res.ok) {
    throw new SafeGatewayError(`PayPal token request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new SafeGatewayError("PayPal token response had no token");
  cachedToken = {
    key,
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 0) * 1000 - TOKEN_MARGIN_MS,
  };
  return body.access_token;
}

/** One 30 second budget covering the token request, the call and the body read. */
async function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

type PayPalErrorBody = {
  name?: unknown;
  details?: unknown;
};

/**
 * Live sandbox behaviour: HTTP 400 USER_BUSINESS_ERROR, with a details entry for
 * field SENDER_BATCH_ID whose self link points at the original batch. The name
 * alone proves nothing, since PayPal uses it for other business errors.
 */
function parseDuplicateBatch(body: PayPalErrorBody | null): { batchId?: string } | undefined {
  if (!Array.isArray(body?.details)) return undefined;
  const detail = (body.details as { field?: unknown; link?: unknown }[]).find(
    (d) => d?.field === "SENDER_BATCH_ID",
  );
  if (!detail) return undefined;
  const links = Array.isArray(detail.link) ? (detail.link as { rel?: unknown; href?: unknown }[]) : [];
  const self = links.find((l) => l?.rel === "self" && typeof l.href === "string");
  const match = /\/v1\/payments\/payouts\/([A-Za-z0-9_-]+)\/?(?:[?#]|$)/.exec(String(self?.href));
  return match ? { batchId: match[1] } : {};
}

/** Foreign error messages may echo the request, so only the error type is kept. */
export function describeGatewayError(e: unknown): string {
  if (e instanceof SafeGatewayError) return e.message;
  return e instanceof Error ? e.name : "Error";
}

export const restPayoutGateway: PayoutGateway = {
  create(i) {
    const value = toPayPalValue(i.amount);
    return withDeadline(async (signal): Promise<PayoutCreateResult> => {
      try {
        const c = credentials();
        const token = await accessToken(c, signal);
        const res = await fetch(`${c.baseUrl}/v1/payments/payouts`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sender_batch_header: { sender_batch_id: i.senderBatchId },
            items: [
              {
                recipient_type: "EMAIL",
                amount: { value, currency: CURRENCY },
                receiver: i.receiver,
                note: i.note,
              },
            ],
          }),
          signal,
        });

        if (res.status >= 400 && res.status < 500) {
          if (res.status === 401) clearPayPalTokenCache();
          const body = (await res.json().catch(() => null)) as PayPalErrorBody | null;
          // The name is a PayPal enum. Messages and details can echo the receiver.
          const name = typeof body?.name === "string" ? ` ${body.name}` : "";
          const duplicate = parseDuplicateBatch(body);
          if (duplicate) {
            return {
              kind: "duplicate",
              ...duplicate,
              error: `HTTP ${res.status}${name} SENDER_BATCH_ID`,
            };
          }
          return {
            kind: AMBIGUOUS_4XX.has(res.status) ? "unknown" : "rejected",
            error: `HTTP ${res.status}${name}`,
          };
        }
        if (!res.ok) return { kind: "unknown", error: `HTTP ${res.status}` };

        const body = (await res.json()) as {
          batch_header?: { payout_batch_id?: string; batch_status?: string };
        };
        const batchId = body.batch_header?.payout_batch_id;
        if (!batchId) {
          // Accepted, perhaps, but with nothing to track. A retry will find out.
          return { kind: "unknown", error: `HTTP ${res.status} with no batch id` };
        }
        return { kind: "sent", batchId, status: body.batch_header?.batch_status ?? "" };
      } catch (e) {
        return { kind: "unknown", error: describeGatewayError(e) };
      }
    });
  },

  get(batchId) {
    return withDeadline(async (signal) => {
      const c = credentials();
      const token = await accessToken(c, signal);
      const res = await fetch(
        `${c.baseUrl}/v1/payments/payouts/${encodeURIComponent(batchId)}`,
        { headers: { authorization: `Bearer ${token}` }, signal },
      );
      if (res.status === 401) clearPayPalTokenCache();
      if (!res.ok) throw new SafeGatewayError(`PayPal batch read failed: HTTP ${res.status}`);

      const body = (await res.json()) as {
        batch_header?: { batch_status?: string };
        items?: {
          payout_item_id?: string;
          transaction_status?: string;
          payout_item_fee?: { value?: string };
        }[];
      };
      const batchStatus = body.batch_header?.batch_status;
      if (!batchStatus) throw new SafeGatewayError("PayPal batch read had no status");

      const item = body.items?.[0];
      const fee = item?.payout_item_fee?.value;
      const status: PayoutBatchStatus = { batchStatus };
      if (item?.payout_item_id) status.itemId = item.payout_item_id;
      if (item?.transaction_status) status.itemStatus = item.transaction_status;
      if (fee !== undefined) {
        // A fee we cannot read must not stop the status it arrived with.
        try {
          status.fee = fromPayPalValue(fee);
        } catch {
          console.warn(`Unreadable PayPal fee on batch ${batchId}`);
        }
      }
      return status;
    });
  },
};

/** The real PayPal gateway, or the end-to-end test's fake. Production cannot reach the fake. */
export function payoutGateway(): PayoutGateway {
  return e2eFakesEnabled() ? fakePayoutGateway : restPayoutGateway;
}
