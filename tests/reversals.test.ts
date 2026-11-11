import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db, withColonyLock } from "../src/server/db/client";
import { allocations, cats, donationReversals, donations, reviewRequests, webhookEvents } from "../src/server/db/schema";
import { InsufficientFunds, allocateToCat, getPoolStatus } from "../src/server/ledger";
import { getLedger } from "../src/server/impact";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { conservation, ledgerTotals } from "../src/lib/impact";
import { recordCapture } from "../src/server/paypal/orders";
import { applyCaptureReversal } from "../src/server/paypal/reversals";
import { clearPayPalTokenCache } from "../src/server/paypal/payouts";
import { truncateAll } from "./helpers/db";
import {
  captureEvent,
  captureFor,
  FIXTURE_FEE,
  FIXTURE_GROSS,
  FIXTURE_NET,
  makeDonor,
  makePendingOrder,
  reversalEvent,
} from "./helpers/donationFixtures";
import { POST } from "../src/app/api/webhooks/paypal/route";

const SIG = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-11-03T00:00:00Z",
};
let verifyStatus = "SUCCESS";

const send = (body: unknown) =>
  POST(new Request("http://localhost/api/webhooks/paypal", { method: "POST", headers: SIG, body: JSON.stringify(body) }));

const pool = () => db.transaction((tx) => getPoolStatus(tx));
const reversals = () => db.select().from(donationReversals);
const reviews = () => db.select().from(reviewRequests);

/** A captured donation: gross 100.00, fee 18.40, net 81.60, capture id from the real sandbox fixture. */
async function captured() {
  const u = await makeDonor();
  const { orderId } = await makePendingOrder(u.id);
  await recordCapture(captureFor(orderId));
  const [row] = await db.select().from(donations).where(eq(donations.paypalOrderId, orderId));
  return { orderId, row, userId: u.id };
}

async function fundACat(amount: number) {
  const [cat] = await db.insert(cats).values({ name: "Mimi", areaName: "Brgy 1" }).returning();
  await withColonyLock((tx) => allocateToCat(tx, cat.id, amount));
  return cat;
}

beforeEach(async () => {
  await truncateAll();
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-TEST");
  verifyStatus = "SUCCESS";
  clearPayPalTokenCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/v1/notifications/verify-webhook-signature")) return Response.json({ verification_status: verifyStatus });
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(closePool);

describe("a full refund", () => {
  it("takes the money out of the pool with its own row and leaves the donation as it was", async () => {
    const { row } = await captured();
    const res = await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: FIXTURE_GROSS, fee: FIXTURE_FEE }));
    expect(res.status).toBe(200);

    const [after] = await db.select().from(donations).where(eq(donations.id, row.id));
    expect(after).toEqual(row);
    expect(await reversals()).toEqual([
      expect.objectContaining({
        donationId: row.id,
        kind: "refund",
        paypalRef: "RF-1",
        grossDelta: -FIXTURE_GROSS,
        feeDelta: -FIXTURE_FEE,
        netDelta: -FIXTURE_NET,
        basis: "breakdown",
      }),
    ]);
    const p = await pool();
    expect(p).toMatchObject({ grossIn: 0, paypalFees: 0, available: 0 });
    expect(conservation(p).balanced).toBe(true);
  });

  it("shows as a negative ledger row whose totals still equal the pool", async () => {
    await captured();
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 4000, fee: 0 }));
    const rows = await getLedger();
    expect(rows.map((r) => r.type).sort()).toEqual(["donation", "refund"]);
    const refund = rows.find((r) => r.type === "refund")!;
    expect(refund).toMatchObject({ amount: -4000, fee: 0, status: "refunded", paypalId: "RF-1" });
    const t = ledgerTotals(rows);
    const p = await pool();
    expect(t).toMatchObject({ donated: p.grossIn, paypalFees: p.paypalFees });
    expect(conservation(p)).toMatchObject({ balanced: true });
  });
});

describe("a partial refund", () => {
  it("uses the amount and the fee effect PayPal reports", async () => {
    await captured();
    // PayPal gave back 5.00 of the fee on a 30.00 refund: the seller is debited 25.00.
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 3000, fee: 500 }));
    const [r] = await reversals();
    expect(r).toMatchObject({ grossDelta: -3000, feeDelta: -500, netDelta: -2500 });
    const p = await pool();
    expect(p).toMatchObject({ grossIn: 7000, paypalFees: FIXTURE_FEE - 500, available: FIXTURE_NET - 2500 });
    expect(conservation(p).balanced).toBe(true);
  });

  it("two partial refunds add up, and an extra one beyond the donation is not recorded but asked about", async () => {
    await captured();
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 6000 }));
    await send(reversalEvent("EV-R2", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-2", gross: 4000 }));
    expect(await reversals()).toHaveLength(2);
    expect((await pool()).grossIn).toBe(0);

    const res = await send(reversalEvent("EV-R3", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-3", gross: 100 }));
    expect(res.status).toBe(200);
    expect(await reversals()).toHaveLength(2);
    // Refunding the whole 100.00 with no fee given back also leaves the pool 18.40 short: that has its own question.
    const asked = (await reviews()).filter((q) => q.reason.includes("RF-3"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ status: "open", subject: "PayPal sent a refund the fund could not apply" });
  });

  it("ignores a refund that is not completed yet, and takes it when the same refund completes", async () => {
    await captured();
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 3000, status: "PENDING" }));
    expect(await reversals()).toHaveLength(0);
    await send(reversalEvent("EV-R2", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 3000 }));
    expect(await reversals()).toHaveLength(1);
  });
});

describe("a refund after the money was allocated", () => {
  it("shows the true pool, refuses new funding, claws nothing back and asks a caretaker", async () => {
    await captured();
    const cat = await fundACat(FIXTURE_NET);
    expect((await pool()).available).toBe(0);

    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: FIXTURE_GROSS, fee: FIXTURE_FEE }));

    const p = await pool();
    expect(p.available).toBe(-FIXTURE_NET);
    expect(p.heldForCats).toBe(FIXTURE_NET);
    expect(conservation(p).balanced).toBe(true);
    expect(await db.select().from(allocations)).toHaveLength(1);
    // The Proof sentence says so in plain words and still adds up.
    expect(conservation(p).text).toContain("after ₱100.00 that PayPal took back");
    expect(conservation(p).text).toContain("still free -₱81.60");
    expect(conservation(p).text).toContain("below zero");
    // Proof hides the long sum when its bar is drawn, so the refund and below-zero clauses also come on their own.
    expect(conservation(p).note).toContain("₱100.00 that PayPal took back");
    expect(conservation(p).note).toContain("below zero");
    expect(conservation(p).note).not.toContain("Donated ₱");

    // New money arrives, but the pool is still short, so nothing new can be funded from the old gap.
    const [other] = await db.insert(cats).values({ name: "Tuti", areaName: "Brgy 2" }).returning();
    await expect(withColonyLock((tx) => allocateToCat(tx, other.id, 100))).rejects.toBeInstanceOf(InsufficientFunds);
    expect(cat.id).not.toBe(other.id);

    const asked = await reviews();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ status: "open" });
    const [r] = await reversals();
    expect(r.reviewRequestId).toBe(asked[0].id);
    const queue = await getCaretakerQueue();
    expect(queue.reviews.map((x) => x.id)).toContain(asked[0].id);
  });

  it("opens no question when the pool stays at or above zero", async () => {
    await captured();
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 3000 }));
    expect(await reviews()).toHaveLength(0);
  });
});

describe("replays and order", () => {
  it("the same event id twice changes nothing twice", async () => {
    await captured();
    const ev = reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 3000 });
    await send(ev);
    const again = await send(ev);
    expect(await again.json()).toEqual({ result: "duplicate" });
    expect(await reversals()).toHaveLength(1);
    expect((await pool()).grossIn).toBe(7000);
  });

  it("the same refund under a new event id changes nothing twice, and opens one question", async () => {
    await captured();
    await fundACat(FIXTURE_NET);
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: FIXTURE_GROSS, fee: FIXTURE_FEE }));
    await send(reversalEvent("EV-R2", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: FIXTURE_GROSS, fee: FIXTURE_FEE }));
    expect(await reversals()).toHaveLength(1);
    expect(await reviews()).toHaveLength(1);
    expect((await pool()).available).toBe(-FIXTURE_NET);
  });

  it("a refund that arrives before its capture waits, then counts once the capture is recorded", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    // The refund names its order, the capture event has not arrived.
    const res = await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 3000, orderId }));
    expect(res.status).toBe(200);
    expect(await reversals()).toHaveLength(1);
    expect(await pool()).toMatchObject({ grossIn: 0, available: 0 });

    await send(captureEvent("EV-C1", orderId));
    expect(await pool()).toMatchObject({ grossIn: 7000, paypalFees: FIXTURE_FEE, available: FIXTURE_NET - 3000 });
    // And the capture arriving twice still counts the refund once.
    await send(captureEvent("EV-C2", orderId));
    expect((await pool()).grossIn).toBe(7000);
  });

  it("a refund for a capture we have never heard of is retried by PayPal, and writes nothing", async () => {
    const res = await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", captureId: "NO-SUCH-CAPTURE" }));
    expect(res.status).toBe(500);
    expect(await reversals()).toHaveLength(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);

    // The capture is recorded, PayPal retries the same event, and now it lands.
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    await recordCapture(captureFor(orderId, { id: "NO-SUCH-CAPTURE" }));
    const retry = await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", captureId: "NO-SUCH-CAPTURE", gross: 3000 }));
    expect(retry.status).toBe(200);
    expect(await reversals()).toHaveLength(1);
  });
});

describe("a bad signature", () => {
  it("returns 400 and changes nothing", async () => {
    await captured();
    verifyStatus = "FAILURE";
    const res = await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: FIXTURE_GROSS, fee: FIXTURE_FEE }));
    expect(res.status).toBe(400);
    expect(await reversals()).toHaveLength(0);
    expect(await reviews()).toHaveLength(0);
    expect((await pool()).grossIn).toBe(FIXTURE_GROSS);
  });
});

describe("a reversal (chargeback) and a denial", () => {
  it("REVERSED with PayPal's breakdown takes exactly that", async () => {
    await captured();
    await send(reversalEvent("EV-V1", "PAYMENT.CAPTURE.REVERSED", { refundId: "RV-1", gross: FIXTURE_GROSS, fee: 0 }));
    const [r] = await reversals();
    expect(r).toMatchObject({ kind: "reversal", grossDelta: -FIXTURE_GROSS, feeDelta: 0, netDelta: -FIXTURE_GROSS });
  });

  it("REVERSED with no breakdown takes what the donation still holds in net and keeps its fee as spent", async () => {
    await captured();
    await send(reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", gross: 2000 }));
    await send(reversalEvent("EV-V1", "PAYMENT.CAPTURE.REVERSED", { refundId: "RV-1", breakdown: false }));
    const rows = await reversals();
    const v = rows.find((x) => x.kind === "reversal")!;
    expect(v).toMatchObject({ basis: "remaining", feeDelta: 0, grossDelta: -(FIXTURE_NET - 2000), netDelta: -(FIXTURE_NET - 2000) });
    const p = await pool();
    expect(p.available).toBe(0);
    expect(conservation(p).balanced).toBe(true);
  });

  it("DENIED on a captured donation is treated as a reversal; the same denial twice counts once", async () => {
    await captured();
    const ev = (id: string) => reversalEvent(id, "PAYMENT.CAPTURE.DENIED", { refundId: "ignored", breakdown: false });
    // A denial names the capture itself: its id is the key.
    const body = ev("EV-D1");
    (body.resource as { id: string }).id = String(captureFor("x").id);
    await send(body);
    const body2 = ev("EV-D2");
    (body2.resource as { id: string }).id = String(captureFor("x").id);
    await send(body2);
    const rows = await reversals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "denied", basis: "remaining" });
    expect((await pool()).available).toBe(0);
  });

  it("an unreadable refund breakdown is not guessed: it opens a question and records nothing", async () => {
    await captured();
    const ev = reversalEvent("EV-R1", "PAYMENT.CAPTURE.REFUNDED", { refundId: "RF-1", breakdown: false });
    expect((await send(ev)).status).toBe(200);
    expect(await reversals()).toHaveLength(0);
    expect(await reviews()).toHaveLength(1);
  });
});

describe("a refund and a capture committing together", () => {
  it("the refund waits for the donation row", async () => {
    const u = await makeDonor();
    const { orderId } = await makePendingOrder(u.id);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    // Another transaction holds the donation row the way recordCapture's update does (it does not touch the key).
    const holder = db.transaction(async (tx) => {
      await tx.select().from(donations).where(eq(donations.paypalOrderId, orderId)).for("no key update");
      locked();
      await held;
    });
    await lockedP;
    let done = false;
    const refund = db
      .transaction((tx) =>
        applyCaptureReversal(tx, "refund", {
          id: "RF-RACE",
          status: "COMPLETED",
          seller_payable_breakdown: {
            gross_amount: { currency_code: "PHP", value: "10.00" },
            paypal_fee: { currency_code: "PHP", value: "0.00" },
            net_amount: { currency_code: "PHP", value: "10.00" },
          },
          supplementary_data: { related_ids: { order_id: orderId } },
        }),
      )
      .then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    await refund;
    expect(done).toBe(true);
  });
});
