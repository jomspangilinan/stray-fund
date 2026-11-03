import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { donations, wakeups, webhookEvents } from "../src/server/db/schema";
import { clearPayPalTokenCache } from "../src/server/paypal/payouts";
import { truncateAll } from "./helpers/db";
import { captureEvent, makeDonor, makePendingOrder } from "./helpers/donationFixtures";

const applyPayoutStatusIn = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/server/moneyGate", async (orig) => ({
  ...(await orig<typeof import("../src/server/moneyGate")>()),
  applyPayoutStatusIn,
}));

import { POST } from "../src/app/api/webhooks/paypal/route";

const SIG_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-11-03T00:00:00Z",
};

let verifyStatus = "SUCCESS";
let verifyCalls: { url: string; body: string }[] = [];

function stubPayPal() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/oauth2/token")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
        verifyCalls.push({ url, body: String(init?.body) });
        return Response.json({ verification_status: verifyStatus });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
}

const send = (raw: string, headers: Record<string, string> = SIG_HEADERS) =>
  POST(new Request("http://localhost/api/webhooks/paypal", { method: "POST", headers, body: raw }));

const eventRows = () => db.select().from(webhookEvents);
const wakeupRows = () => db.select().from(wakeups);

beforeEach(async () => {
  await truncateAll();
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-TEST");
  verifyStatus = "SUCCESS";
  verifyCalls = [];
  applyPayoutStatusIn.mockClear();
  clearPayPalTokenCache();
  stubPayPal();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(closePool);

describe("signature", () => {
  it("invalid signature returns 400 and writes nothing", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    verifyStatus = "FAILURE";
    const res = await send(JSON.stringify(captureEvent("EV-1", orderId)));
    expect(res.status).toBe(400);
    expect(await eventRows()).toHaveLength(0);
    expect(await wakeupRows()).toHaveLength(0);
    expect((await db.select().from(donations))[0].status).toBe("pending");
  });

  it("sends the raw body to PayPal unchanged and the webhook id", async () => {
    // Odd spacing and key order would not survive a parse and stringify.
    const raw = `{ "id":"EV-RAW",  "event_type":"SOMETHING.ELSE", "resource":{"z":1,"a":2} }`;
    const res = await send(raw);
    expect(res.status).toBe(200);
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0].body).toContain(`"webhook_event":${raw}}`);
    const parsed = JSON.parse(verifyCalls[0].body);
    expect(parsed).toMatchObject({
      webhook_id: "WH-TEST",
      transmission_id: "tx-1",
      auth_algo: "SHA256withRSA",
    });
  });

  it("rejects with 400 when PAYPAL_WEBHOOK_ID is unset, and never calls PayPal", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const res = await send(JSON.stringify({ id: "EV-1", event_type: "X" }));
    expect(res.status).toBe(400);
    expect(verifyCalls).toHaveLength(0);
    expect(await eventRows()).toHaveLength(0);
  });

  it("rejects with 400 when a signature header is missing", async () => {
    const rest: Record<string, string> = { ...SIG_HEADERS };
    delete rest["paypal-transmission-sig"];
    const res = await send(JSON.stringify({ id: "EV-1", event_type: "X" }), rest);
    expect(res.status).toBe(400);
    expect(verifyCalls).toHaveLength(0);
  });
});

describe("events", () => {
  it("records a capture and queues one wakeup", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const res = await send(JSON.stringify(captureEvent("EV-1", orderId)));
    expect(res.status).toBe(200);
    expect((await db.select().from(donations))[0].status).toBe("captured");
    expect(await eventRows()).toHaveLength(1);
    expect(await wakeupRows()).toHaveLength(1);
  });

  it("a replayed event id is a no-op returning 200", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const raw = JSON.stringify(captureEvent("EV-1", orderId));
    expect((await send(raw)).status).toBe(200);
    const again = await send(raw);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ result: "duplicate" });
    expect(await eventRows()).toHaveLength(1);
    expect(await wakeupRows()).toHaveLength(1);
  });

  it("returns 200 for unknown event types", async () => {
    const res = await send(JSON.stringify({ id: "EV-9", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} }));
    expect(res.status).toBe(200);
  });

  it("logs and acknowledges a capture for an unknown order, with no donation row", async () => {
    const res = await send(JSON.stringify(captureEvent("EV-1", "NO-SUCH-ORDER")));
    expect(res.status).toBe(200);
    expect(await db.select().from(donations)).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("returns 500 and rolls back the dedupe row when the effect fails, so a retry works", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const bad = captureEvent("EV-1", orderId);
    (bad.resource as { seller_receivable_breakdown: { net_amount: { value: string } } })
      .seller_receivable_breakdown.net_amount.value = "1.00";
    const res = await send(JSON.stringify(bad));
    expect(res.status).toBe(500);
    expect(await eventRows()).toHaveLength(0);
    // PayPal retries the same id with a good body.
    const ok = await send(JSON.stringify(captureEvent("EV-1", orderId)));
    expect(ok.status).toBe(200);
    expect((await db.select().from(donations))[0].status).toBe("captured");
  });

  it("passes batch id, item id, status, fee and senderBatchId to applyPayoutStatus", async () => {
    const res = await send(
      JSON.stringify({
        id: "EV-P1",
        event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        resource: {
          payout_batch_id: "BATCH-1",
          payout_item_id: "ITEM-1",
          sender_batch_id: "11111111-1111-1111-1111-111111111111",
          transaction_status: "SUCCESS",
          payout_item_fee: { currency_code: "PHP", value: "0.20" },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(applyPayoutStatusIn).toHaveBeenCalledTimes(1);
    const [, batchId, update] = applyPayoutStatusIn.mock.calls[0] as unknown as [unknown, string, object];
    expect(batchId).toBe("BATCH-1");
    expect(update).toEqual({
      itemStatus: "SUCCESS",
      itemId: "ITEM-1",
      fee: 20,
      senderBatchId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("returns 500 and keeps no dedupe row when the payout handler throws", async () => {
    applyPayoutStatusIn.mockRejectedValueOnce(new Error("db down"));
    const res = await send(
      JSON.stringify({
        id: "EV-P2",
        event_type: "PAYMENT.PAYOUTS-ITEM.FAILED",
        resource: { payout_batch_id: "B", transaction_status: "FAILED" },
      }),
    );
    expect(res.status).toBe(500);
    expect(await eventRows()).toHaveLength(0);
  });
});

