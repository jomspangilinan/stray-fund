import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { donations, wakeups } from "../src/server/db/schema";
import {
  captureDonation,
  captureFromOrder,
  createDonationOrder,
  ForbiddenOrder,
  TooManyOrders,
  CaptureMismatch,
  InvalidAmount,
  recordCapture,
  UnknownOrder,
  type OrdersGateway,
} from "../src/server/paypal/orders";
import { handleWebhookEvent } from "../src/server/paypal/webhook";
import { truncateAll } from "./helpers/db";
import {
  captureEvent,
  captureFor,
  FIXTURE_FEE,
  FIXTURE_GROSS,
  FIXTURE_NET,
  makeDonor,
  makePendingOrder,
} from "./helpers/donationFixtures";

const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const wakeupCount = async () =>
  (await db.select().from(wakeups).where(eq(wakeups.kind, "donation_captured"))).length;
const rows = () => db.select().from(donations);

beforeEach(async () => {
  await truncateAll();
});
afterAll(closePool);

describe("createDonationOrder", () => {
  const gw = (): OrdersGateway => ({
    createOrder: vi.fn(async () => ({ orderId: "PP-ORDER-1" })),
    captureOrder: vi.fn(),
    getOrder: vi.fn(),
  });

  it("inserts a pending row with the gross, and fee and net at 0", async () => {
    const u = await makeDonor();
    const g = gw();
    const { orderId } = await createDonationOrder(u.id, 50_000, ATTEMPT, g);
    expect(orderId).toBe("PP-ORDER-1");
    expect(g.createOrder).toHaveBeenCalledWith(50_000, expect.stringContaining(ATTEMPT));
    const [row] = await rows();
    expect(row).toMatchObject({
      userId: u.id,
      gross: 50_000,
      paypalFee: 0,
      net: 0,
      status: "pending",
      paypalOrderId: "PP-ORDER-1",
    });
  });

  it.each([
    ["below the minimum", 9_999],
    ["a non-integer", 10_000.5],
    ["a string", "50000"],
    ["NaN", Number.NaN],
    ["negative", -10_000],
    ["above the maximum", 10_000_001],
    ["missing", undefined],
  ])("rejects an amount that is %s, without calling PayPal", async (_n, amount) => {
    const u = await makeDonor();
    const g = gw();
    await expect(createDonationOrder(u.id, amount, ATTEMPT, g)).rejects.toBeInstanceOf(InvalidAmount);
    expect(g.createOrder).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("caps pending orders at 5 per user in 10 minutes, before calling PayPal", async () => {
    const u = await makeDonor();
    const other = await makeDonor();
    const g = gw();
    for (let i = 0; i < 5; i++) await makePendingOrder(u.id);
    await expect(createDonationOrder(u.id, 10_000, ATTEMPT, g)).rejects.toBeInstanceOf(TooManyOrders);
    expect(g.createOrder).not.toHaveBeenCalled();
    // Another user is unaffected.
    await expect(createDonationOrder(other.id, 10_000, ATTEMPT, g)).resolves.toBeDefined();
  });

  it("does not count old pending orders or captured ones", async () => {
    const u = await makeDonor();
    for (let i = 0; i < 4; i++) {
      const { row } = await makePendingOrder(u.id);
      await db
        .update(donations)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(donations.id, row.id));
    }
    const { orderId } = await makePendingOrder(u.id);
    await recordCapture(captureFor(orderId));
    await makePendingOrder(u.id);
    await expect(createDonationOrder(u.id, 10_000, ATTEMPT, gw())).resolves.toBeDefined();
  });

  it("accepts exactly the minimum", async () => {
    const u = await makeDonor();
    await expect(createDonationOrder(u.id, 10_000, ATTEMPT, gw())).resolves.toBeDefined();
  });
});

describe("recordCapture", () => {
  it("takes fee and net from seller_receivable_breakdown and writes captured", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const d = await recordCapture(captureFor(orderId));
    expect(d).toMatchObject({
      status: "captured",
      gross: FIXTURE_GROSS,
      paypalFee: FIXTURE_FEE,
      net: FIXTURE_NET,
      paypalCaptureId: "ID_FAKE003",
    });
    expect(await wakeupCount()).toBe(1);
  });

  it("refuses a breakdown that does not add up and records nothing", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const cap = captureFor(orderId);
    cap.seller_receivable_breakdown!.net_amount!.value = "90.00";
    await expect(recordCapture(cap)).rejects.toBeInstanceOf(CaptureMismatch);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", net: 0, paypalFee: 0, paypalCaptureId: null });
    expect(await wakeupCount()).toBe(0);
  });

  it("refuses a capture in another currency", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const cap = captureFor(orderId);
    cap.seller_receivable_breakdown!.gross_amount!.currency_code = "USD";
    await expect(recordCapture(cap)).rejects.toBeInstanceOf(CaptureMismatch);
    expect((await rows())[0].status).toBe("pending");
  });

  it("refuses a capture for a different amount than the order", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id, 50_000);
    await expect(recordCapture(captureFor(orderId))).rejects.toBeInstanceOf(CaptureMismatch);
    expect((await rows())[0].status).toBe("pending");
  });

  it("refuses a completed capture with no breakdown", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const cap = captureFor(orderId);
    delete cap.seller_receivable_breakdown;
    await expect(recordCapture(cap)).rejects.toBeInstanceOf(CaptureMismatch);
  });

  it("records nothing as captured when the status is not COMPLETED", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const d = await recordCapture(captureFor(orderId, { status: "PENDING" }));
    expect(d.status).toBe("pending");
    expect((await rows())[0]).toMatchObject({ status: "pending", net: 0 });
    expect(await wakeupCount()).toBe(0);
  });

  it("throws UnknownOrder and writes no row for an unknown order", async () => {
    await expect(recordCapture(captureFor("NOPE"))).rejects.toBeInstanceOf(UnknownOrder);
    expect(await rows()).toHaveLength(0);
  });

  it("a database check refuses a captured row that does not add up", async () => {
    const u = await makeDonor();
    const { row } = await makePendingOrder(u.id);
    await expect(
      db.update(donations).set({ status: "captured", net: 5 }).where(eq(donations.id, row.id)),
    ).rejects.toThrow();
  });
});

describe("capture and webhook counting once", () => {
  it("capture then webhook counts once", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    await recordCapture(captureFor(orderId));
    await handleWebhookEvent(captureEvent("EV-1", orderId));
    expect(await rows()).toHaveLength(1);
    expect(await wakeupCount()).toBe(1);
  });

  it("webhook then capture counts once", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    await handleWebhookEvent(captureEvent("EV-1", orderId));
    const d = await recordCapture(captureFor(orderId));
    expect(d.status).toBe("captured");
    expect(await rows()).toHaveLength(1);
    expect(await wakeupCount()).toBe(1);
  });

  it("concurrent both count once, on separate connections", async () => {
    for (let i = 0; i < 5; i++) {
      await truncateAll();
      const u = await makeDonor();
      const { orderId } = await makePendingOrder(u.id);
      await Promise.all([
        recordCapture(captureFor(orderId)),
        handleWebhookEvent(captureEvent(`EV-${i}`, orderId)),
        recordCapture(captureFor(orderId)),
        handleWebhookEvent(captureEvent(`EV-${i}-b`, orderId)),
      ]);
      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ status: "captured", net: FIXTURE_NET });
      expect(await wakeupCount()).toBe(1);
    }
  });
});

describe("captureDonation", () => {
  const orderBody = (orderId: string) => ({
    id: orderId,
    purchase_units: [{ payments: { captures: [captureFor(orderId)] } }],
  });

  it("captures at PayPal and records once", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const gw: OrdersGateway = { createOrder: vi.fn(), getOrder: vi.fn(), captureOrder: vi.fn(async () => orderBody(orderId)) };
    const d = await captureDonation(u.id, orderId, gw);
    expect(d).toMatchObject({ status: "captured", net: FIXTURE_NET });
    // A second call does not call PayPal again.
    await captureDonation(u.id, orderId, gw);
    expect(gw.captureOrder).toHaveBeenCalledTimes(1);
    expect(await wakeupCount()).toBe(1);
  });

  it("refuses another user's order and never calls PayPal", async () => {
    const owner = await makeDonor();
    const other = await makeDonor();
    const { orderId } = await makePendingOrder(owner.id);
    const gw: OrdersGateway = { createOrder: vi.fn(), getOrder: vi.fn(), captureOrder: vi.fn() };
    await expect(captureDonation(other.id, orderId, gw)).rejects.toBeInstanceOf(ForbiddenOrder);
    expect(gw.captureOrder).not.toHaveBeenCalled();
    expect((await rows())[0].status).toBe("pending");
  });

  it("returns the captured row when PayPal refuses because the webhook won", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    const gw: OrdersGateway = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      captureOrder: vi.fn(async () => {
        await handleWebhookEvent(captureEvent("EV-WIN", orderId));
        throw new Error("ORDER_ALREADY_CAPTURED");
      }),
    };
    const d = await captureDonation(u.id, orderId, gw);
    expect(d.status).toBe("captured");
    expect(await wakeupCount()).toBe(1);
  });

  it("captureFromOrder rejects a response with no capture", () => {
    expect(() => captureFromOrder({ id: "X", purchase_units: [{}] })).toThrow(CaptureMismatch);
  });
});
