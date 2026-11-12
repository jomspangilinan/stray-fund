import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { readFileSync } from "node:fs";
import { donations, payouts, wakeups, webhookEvents } from "../src/server/db/schema";
import { addPayout, makeWorld } from "./helpers/payoutFixtures";
import { clearPayPalTokenCache } from "../src/server/paypal/payouts";
import { truncateAll } from "./helpers/db";
import { captureEvent, makeDonor, makePendingOrder } from "./helpers/donationFixtures";

// A spy that still runs the real function, so tests can both inspect calls and see effects.
const applyPayoutStatusIn = vi.hoisted(() => vi.fn());
vi.mock("../src/server/moneyGate", async (orig) => {
  const actual = await orig<typeof import("../src/server/moneyGate")>();
  applyPayoutStatusIn.mockImplementation(actual.applyPayoutStatusIn);
  return { ...actual, applyPayoutStatusIn };
});

/** The real sandbox payout item: payout_item_fee uses "currency", not "currency_code". */
const PAYOUT_ITEM = JSON.parse(
  readFileSync(new URL("./fixtures/paypal/payout-batch-PHP-SUCCESS-SUCCESS.json", import.meta.url), "utf8"),
).body.items[0] as Record<string, unknown>;

import { POST } from "../src/app/api/webhooks/paypal/route";

const SIG_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-11-03T00:00:00Z",
};

let verifyStatus = "SUCCESS";
let verifyHttp: number | "network" = 200;
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
        if (verifyHttp === "network") throw new TypeError("fetch failed");
        if (verifyHttp !== 200) return Response.json({ name: "ERR" }, { status: verifyHttp });
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
  verifyHttp = 200;
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

  it("treats a 4xx from the verify call as a failed verification (400)", async () => {
    verifyHttp = 401;
    const res = await send(JSON.stringify({ id: "EV-1", event_type: "X" }));
    expect(res.status).toBe(400);
    expect(await eventRows()).toHaveLength(0);
  });

  it("keeps 500 for a 5xx from the verify call, and for a network error", async () => {
    verifyHttp = 503;
    expect((await send(JSON.stringify({ id: "EV-1", event_type: "X" }))).status).toBe(500);
    verifyHttp = "network";
    expect((await send(JSON.stringify({ id: "EV-1", event_type: "X" }))).status).toBe(500);
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

describe("body cap", () => {
  it("refuses a body over 64 KB with 413 before any call to PayPal", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockClear();
    const res = await send("x".repeat(64 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(await eventRows()).toHaveLength(0);
  });

  it("still processes a genuine event just under the cap", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const res = await send(JSON.stringify(captureEvent("EV-CAP", orderId)));
    expect(res.status).toBe(200);
    expect(await eventRows()).toHaveLength(1);
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

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("treats the event type %s as unknown, not as a handler", async (type) => {
    const res = await send(JSON.stringify({ id: `EV-${type}`, event_type: type, resource: { id: "X" } }));
    expect(res.status).toBe(200);
    expect(await eventRows()).toHaveLength(1);
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
        resource: { ...PAYOUT_ITEM, sender_batch_id: "11111111-1111-1111-1111-111111111111" },
      }),
    );
    expect(res.status).toBe(200);
    expect(applyPayoutStatusIn).toHaveBeenCalledTimes(1);
    const [, batchId, update] = applyPayoutStatusIn.mock.calls[0] as unknown as [unknown, string, object];
    expect(batchId).toBe("BATCH_FAKE001");
    expect(update).toEqual({
      itemStatus: "SUCCESS",
      itemId: "ITEM_FAKE002",
      fee: 20,
      senderBatchId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("a payout item event from the real fixture ends with payouts.fee = 20", async () => {
    const w = await makeWorld();
    const p = await addPayout(w, { amount: 1000, status: "sent", batchId: "BATCH_FAKE001" });
    const res = await send(
      JSON.stringify({
        id: "EV-FEE",
        event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        resource: { ...PAYOUT_ITEM, sender_batch_id: p.id },
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(payouts);
    expect(row).toMatchObject({ status: "succeeded", fee: 20, paypalItemId: "ITEM_FAKE002" });
  });

  it("logs an unreadable fee instead of dropping it silently", async () => {
    await send(
      JSON.stringify({
        id: "EV-BADFEE",
        event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        resource: { ...PAYOUT_ITEM, payout_item_fee: { currency: "USD", value: "0.20" } },
      }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("fee"));
    expect(applyPayoutStatusIn.mock.calls[0][2]).toMatchObject({ fee: undefined });
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

