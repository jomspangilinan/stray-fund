import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { donations } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { makeDonor } from "./helpers/donationFixtures";

const sdkCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("@paypal/paypal-server-sdk", async (orig) => {
  const actual = await orig<typeof import("@paypal/paypal-server-sdk")>();
  class FakeOrders {
    async createOrder(args: unknown) {
      sdkCalls.push(args);
      return { result: { id: "PP-ORDER-SDK" } };
    }
  }
  return { ...actual, OrdersController: FakeOrders, Client: class {} };
});

import {
  createDonationOrder,
  InvalidAttempt,
  sdkOrdersGateway,
  type OrdersGateway,
} from "../src/server/paypal/orders";
import { fakeOrdersGateway } from "../src/server/e2e/paypal";

const A1 = "aaaaaaaa-2222-4333-8444-555555555555";
const A2 = "bbbbbbbb-2222-4333-8444-555555555555";

/** PayPal's PayPal-Request-Id behaviour: one id, one order. */
function idempotentGateway(): OrdersGateway & { ids: string[] } {
  const seen = new Map<string, string>();
  const ids: string[] = [];
  return {
    ids,
    createOrder: vi.fn(async (_amount: number, requestId: string) => {
      ids.push(requestId);
      if (!seen.has(requestId)) seen.set(requestId, `PP-ORDER-${seen.size + 1}`);
      return { orderId: seen.get(requestId)! };
    }),
    captureOrder: vi.fn(),
    getOrder: vi.fn(),
  };
}

beforeEach(async () => {
  await truncateAll();
  sdkCalls.length = 0;
  vi.stubEnv("PAYPAL_CLIENT_ID", "id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
});
afterAll(closePool);

describe("order create sends PayPal-Request-Id", () => {
  it("the real gateway hands the request id to the SDK as paypalRequestId", async () => {
    await sdkOrdersGateway.createOrder(50_000, "req-1");
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]).toMatchObject({ paypalRequestId: "req-1" });
  });

  it("a retry of the same attempt gets the same order and writes one row", async () => {
    const u = await makeDonor();
    const gw = idempotentGateway();
    const first = await createDonationOrder(u.id, 50_000, A1, gw);
    const retry = await createDonationOrder(u.id, 50_000, A1, gw);
    expect(retry).toEqual(first);
    expect(gw.ids[0]).toBe(gw.ids[1]);
    expect(await db.select().from(donations)).toHaveLength(1);
  });

  it("a new attempt gets a new key and a new order", async () => {
    const u = await makeDonor();
    const gw = idempotentGateway();
    const a = await createDonationOrder(u.id, 50_000, A1, gw);
    const b = await createDonationOrder(u.id, 50_000, A2, gw);
    expect(a.orderId).not.toBe(b.orderId);
    expect(gw.ids[0]).not.toBe(gw.ids[1]);
    expect(await db.select().from(donations)).toHaveLength(2);
  });

  it("the same attempt id with another amount, or from another donor, is a different key", async () => {
    const u = await makeDonor();
    const v = await makeDonor();
    const gw = idempotentGateway();
    await createDonationOrder(u.id, 50_000, A1, gw);
    await createDonationOrder(u.id, 60_000, A1, gw);
    await createDonationOrder(v.id, 50_000, A1, gw);
    expect(new Set(gw.ids).size).toBe(3);
  });

  it("refuses a missing or malformed attempt id without calling PayPal", async () => {
    const u = await makeDonor();
    const gw = idempotentGateway();
    for (const bad of [undefined, "", "not-a-uuid", 5, "x".repeat(10_000)]) {
      await expect(createDonationOrder(u.id, 50_000, bad, gw)).rejects.toBeInstanceOf(InvalidAttempt);
    }
    expect(gw.createOrder).not.toHaveBeenCalled();
  });

  it("the end-to-end fake also answers a repeated request id with the same order", async () => {
    const a = await fakeOrdersGateway.createOrder(50_000, "req-1");
    const b = await fakeOrdersGateway.createOrder(50_000, "req-1");
    const c = await fakeOrdersGateway.createOrder(50_000, "req-2");
    expect(a).toEqual(b);
    expect(a.orderId).not.toBe(c.orderId);
  });
});
