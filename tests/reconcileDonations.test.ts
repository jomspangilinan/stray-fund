import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { donationReversals, donations, reviewRequests, wakeups } from "../src/server/db/schema";
import { getPoolStatus } from "../src/server/ledger";
import { handleWebhookEvent } from "../src/server/paypal/webhook";
import type { OrdersGateway } from "../src/server/paypal/orders";
import { OrderNotFound, PayPalRateLimited } from "../src/server/paypal/orders";
import { reconcilePendingDonations } from "../src/server/paypal/reconcileOrders";
import { runMaintenance } from "../src/server/agent/worker";
import { truncateAll } from "./helpers/db";
import { FakeGateway } from "./helpers/payoutFixtures";
import { captureEvent, FIXTURE_CAPTURE, FIXTURE_GROSS, FIXTURE_NET, makeDonor, makePendingOrder } from "./helpers/donationFixtures";

const money = (c: number) => ({ currency_code: "PHP", value: `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}` });

/** What GET /v2/checkout/orders/{id} returns for an order captured at PayPal. */
function orderBody(orderId: string, o: { status?: string; captureStatus?: string; refunds?: unknown[]; gross?: number; captureId?: string } = {}) {
  const capture = { ...structuredClone(FIXTURE_CAPTURE), status: o.captureStatus ?? "COMPLETED", ...(o.captureId ? { id: o.captureId } : {}) };
  if (o.gross !== undefined) {
    capture.seller_receivable_breakdown = { gross_amount: money(o.gross), paypal_fee: money(0), net_amount: money(o.gross) };
  }
  return {
    id: orderId,
    status: o.status ?? "COMPLETED",
    purchase_units: [{ payments: { captures: o.status === "CREATED" ? [] : [capture], ...(o.refunds ? { refunds: o.refunds } : {}) } }],
  };
}

function gateway(bodyFor: (orderId: string) => unknown | Error) {
  const gw = {
    createOrder: vi.fn(),
    captureOrder: vi.fn(async (orderId: string) => orderBody(orderId)),
    getOrder: vi.fn(async (orderId: string) => {
      const r = bodyFor(orderId);
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  return gw satisfies OrdersGateway;
}

const age = (orderId: string, minutes: number) =>
  db.execute(sql`update donations set created_at = now() - make_interval(mins => ${minutes}) where paypal_order_id = ${orderId}`);
const row = async (orderId: string) => (await db.select().from(donations).where(eq(donations.paypalOrderId, orderId)))[0];
const captureWakeups = async () => (await db.select().from(wakeups).where(eq(wakeups.kind, "donation_captured"))).length;
const run = (gw: OrdersGateway, batch = 10) => reconcilePendingDonations(gw, { batch, paceMs: 0 });

async function pendingOrder(minutesOld: number) {
  const u = await makeDonor();
  const { orderId } = await makePendingOrder(u.id);
  await age(orderId, minutesOld);
  return orderId;
}

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(closePool);

describe("a capture whose webhook was lost", () => {
  it("is found at PayPal and recorded through recordCapture, with one wakeup", async () => {
    const orderId = await pendingOrder(30);
    const gw = gateway((id) => orderBody(id));
    await run(gw);
    expect(gw.getOrder).toHaveBeenCalledWith(orderId);
    expect(await row(orderId)).toMatchObject({ status: "captured", net: FIXTURE_NET, gross: FIXTURE_GROSS });
    expect(await captureWakeups()).toBe(1);
  });

  it("writes once when the webhook arrives too, in either order", async () => {
    const a = await pendingOrder(30);
    const b = await pendingOrder(30);
    const gw = gateway((id) => orderBody(id, { captureId: "CAP-B" }));
    // Webhook first for a, then the poll.
    await handleWebhookEvent(captureEvent("EV-A", a, { id: "CAP-A" }));
    // Poll first for b, then the webhook.
    await run(gw);
    await handleWebhookEvent(captureEvent("EV-B", b));
    await run(gw);
    expect(gw.getOrder).toHaveBeenCalledTimes(1);
    expect(gw.getOrder).toHaveBeenCalledWith(b);
    expect((await db.select().from(donations)).map((d) => d.status)).toEqual(["captured", "captured"]);
    expect(await captureWakeups()).toBe(2);
    expect((await db.transaction((tx) => getPoolStatus(tx))).grossIn).toBe(2 * FIXTURE_GROSS);
  });

  it("an order the donor approved but nobody captured is never captured by the worker, it only backs off", async () => {
    // The page may have told the donor it failed, and they may have paid on a second order. Only the donor's own tap captures.
    const orderId = await pendingOrder(30);
    const gw = gateway(() => ({ id: orderId, status: "APPROVED", purchase_units: [{}] }));
    await run(gw);
    expect(gw.captureOrder).not.toHaveBeenCalled();
    expect(await row(orderId)).toMatchObject({ status: "pending", net: 0, reconcileAttempts: 1 });
    expect((await row(orderId)).reconcileAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(await captureWakeups()).toBe(0);
  });

  it("an order that is only created, or a capture still pending, stays pending", async () => {
    const created = await pendingOrder(30);
    const pending = await pendingOrder(30);
    const gw = gateway((id) => (id === created ? orderBody(id, { status: "CREATED" }) : orderBody(id, { captureStatus: "PENDING" })));
    await run(gw);
    expect((await db.select().from(donations)).map((d) => d.status)).toEqual(["pending", "pending"]);
    expect(await captureWakeups()).toBe(0);
    expect(created).not.toBe(pending);
  });

  it("a capture refunded before the poll lands as captured plus its refund, once", async () => {
    const orderId = await pendingOrder(30);
    const refund = {
      id: "RF-POLL",
      status: "COMPLETED",
      amount: money(3000),
      seller_payable_breakdown: { gross_amount: money(3000), paypal_fee: money(0), net_amount: money(3000) },
    };
    const gw = gateway((id) => orderBody(id, { captureStatus: "PARTIALLY_REFUNDED", refunds: [refund] }));
    await run(gw);
    expect((await row(orderId)).status).toBe("captured");
    expect(await db.select().from(donationReversals)).toHaveLength(1);
    await handleWebhookEvent({
      id: "EV-RF",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { ...refund, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${FIXTURE_CAPTURE.id}` }] },
    });
    expect(await db.select().from(donationReversals)).toHaveLength(1);
    expect((await db.transaction((tx) => getPoolStatus(tx))).grossIn).toBe(FIXTURE_GROSS - 3000);
  });
});

describe("what it leaves alone", () => {
  it("does not ask about an order younger than five minutes or older than 72 hours", async () => {
    await pendingOrder(2);
    await pendingOrder(72 * 60 + 5);
    const gw = gateway((id) => orderBody(id));
    await run(gw);
    expect(gw.getOrder).not.toHaveBeenCalled();
  });

  it("a PayPal error changes no money, and the order is asked about again only after a backoff", async () => {
    const orderId = await pendingOrder(30);
    const gw = gateway(() => new Error("HTTP 503"));
    await run(gw);
    const after = await row(orderId);
    expect(after).toMatchObject({ status: "pending", net: 0, paypalFee: 0, paypalCaptureId: null, reconcileAttempts: 1 });
    expect(after.reconcileAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(await captureWakeups()).toBe(0);

    await run(gw);
    expect(gw.getOrder).toHaveBeenCalledTimes(1);

    // The wait is over, PayPal is back.
    await db.execute(sql`update donations set reconcile_after = now() - interval '1 second'`);
    gw.getOrder.mockImplementation(async (id: string) => orderBody(id));
    await run(gw);
    expect((await row(orderId)).status).toBe("captured");
  });

  it("the backoff grows with each failed ask", async () => {
    const orderId = await pendingOrder(30);
    const gw = gateway(() => new Error("HTTP 500"));
    await run(gw);
    const first = (await row(orderId)).reconcileAfter!.getTime();
    await db.execute(sql`update donations set reconcile_after = now() - interval '1 second'`);
    await run(gw);
    const second = (await row(orderId)).reconcileAfter!.getTime();
    expect(second - Date.now()).toBeGreaterThan(first - Date.now());
  });

  it("a capture that does not match the order is not recorded", async () => {
    const orderId = await pendingOrder(30);
    const gw = gateway((id) => orderBody(id, { gross: 5 }));
    await run(gw);
    expect(await row(orderId)).toMatchObject({ status: "pending", net: 0 });
    expect(await captureWakeups()).toBe(0);
  });

  it("is bounded: only one batch per run, oldest first", async () => {
    for (let i = 0; i < 12; i++) await pendingOrder(30 + i);
    const gw = gateway((id) => orderBody(id, { status: "CREATED" }));
    await run(gw, 5);
    expect(gw.getOrder).toHaveBeenCalledTimes(5);
    await run(gw, 5);
    // The first five are backing off, so the next run reaches new ones.
    expect(gw.getOrder).toHaveBeenCalledTimes(10);
    expect(new Set(gw.getOrder.mock.calls.map((c) => c[0])).size).toBe(10);
  });

  it("stops the whole batch on a rate limit", async () => {
    for (let i = 0; i < 4; i++) await pendingOrder(30 + i);
    const gw = gateway(() => new PayPalRateLimited());
    await run(gw);
    expect(gw.getOrder).toHaveBeenCalledTimes(1);
    expect((await db.select().from(donations)).every((d) => d.status === "pending")).toBe(true);
  });
});

describe("terminal answers stop the polling", () => {
  it.each([
    ["VOIDED", (id: string) => orderBody(id, { status: "VOIDED" })],
    ["404", () => new OrderNotFound()],
  ])("an order PayPal calls %s is asked about once", async (_name, answer) => {
    const orderId = await pendingOrder(30);
    const gw = gateway(answer as (id: string) => unknown);
    await run(gw);
    await db.execute(sql`update donations set reconcile_after = null`);
    await run(gw);
    expect(gw.getOrder).toHaveBeenCalledTimes(1);
    expect((await row(orderId)).status).toBe("pending");
    expect(await db.select().from(reviewRequests)).toHaveLength(0);
  });
});

describe("money PayPal holds is never lost quietly", () => {
  const asked = () => db.select().from(reviewRequests);

  it("a COMPLETED order that cannot be recorded opens one caretaker question, however often it is checked", async () => {
    const orderId = await pendingOrder(30);
    const gw = gateway((id) => orderBody(id, { gross: 5 }));
    await run(gw);
    await db.execute(sql`update donations set reconcile_after = null`);
    await run(gw);
    expect(await row(orderId)).toMatchObject({ status: "pending", net: 0 });
    const qs = await asked();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ status: "open" });
    expect(qs[0].reason).toContain(orderId);
  });

  it("a row that ages out with an unresolved check opens one question, and a clean one asks nothing", async () => {
    const stuck = await pendingOrder(30);
    const lapsed = await pendingOrder(30);
    const errored = await pendingOrder(30);
    const gw = gateway((id) =>
      id === stuck ? { id, status: "APPROVED", purchase_units: [{}] } : id === lapsed ? orderBody(id, { status: "CREATED" }) : new Error("HTTP 503"),
    );
    await run(gw);
    for (const id of [stuck, lapsed, errored]) await age(id, 72 * 60 + 10);
    await run(gw);
    await run(gw);
    const qs = await asked();
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => q.reason).join(" ")).toContain(stuck);
    expect(qs.map((q) => q.reason).join(" ")).toContain(errored);
    expect(qs.map((q) => q.reason).join(" ")).not.toContain(lapsed);
    // Asked once: the caretaker closes them and they do not come back.
    await db.execute(sql`update review_requests set status = 'resolved'`);
    await run(gw);
    expect((await asked()).filter((q) => q.status === "open")).toHaveLength(0);
  });
});

describe("a rate limit", () => {
  it("ends the batch and says so without claiming all checks are paused", async () => {
    await pendingOrder(30);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await run(gateway(() => new PayPalRateLimited()));
    const text = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(text).toContain("rate limit");
    expect(text).not.toContain("pausing donation checks");
  });
});

describe("worker maintenance", () => {
  it("runs the check among its jobs", async () => {
    const ran = vi.fn(async () => {});
    await runMaintenance({
      gateway: new FakeGateway(),
      reconcile: async () => {},
      retryUnknown: async () => {},
      retrySightings: async () => {},
      retryEvidence: async () => {},
      backfillAvatars: async () => {},
      reconcileDonations: ran,
    });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("a failing check does not stop the other jobs", async () => {
    const after = vi.fn(async () => {});
    await runMaintenance({
      gateway: new FakeGateway(),
      reconcile: async () => {},
      retryUnknown: async () => {},
      reconcileDonations: async () => {
        throw new Error("boom");
      },
      retrySightings: after,
      retryEvidence: async () => {},
      backfillAvatars: async () => {},
    });
    expect(after).toHaveBeenCalled();
  });
});
