import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, closePool, withColonyLock } from "../src/server/db/client";
import {
  agentActions,
  allocations,
  bookings,
  cats,
  donations,
  payouts,
  users,
} from "../src/server/db/schema";
import {
  InsufficientFunds,
  allocateToCat,
  getPoolStatus,
  returnSurplus,
} from "../src/server/ledger";
import { getLedger } from "../src/server/impact";
import { truncateAll } from "./helpers/db";

let seq = 0;
let clock = Date.parse("2026-01-01T00:00:00Z");

async function donate(
  net: number,
  opts: { fee?: number; status?: string } = {},
) {
  const fee = opts.fee ?? 0;
  seq += 1;
  clock += 1000;
  const [row] = await db
    .insert(donations)
    .values({
      gross: net + fee,
      paypalFee: fee,
      net,
      paypalOrderId: `order-${seq}`,
      status: opts.status ?? "captured",
      createdAt: new Date(clock),
    })
    .returning();
  return row;
}

async function makeCat(name = "Mimi") {
  const [cat] = await db.insert(cats).values({ name, areaName: "Brgy 1" }).returning();
  return cat;
}

async function addPayout(
  catId: string,
  status: string,
  amount: number,
  fee: number | null,
  kind: "deposit" | "balance" = "deposit",
) {
  const [vet] = await db
    .insert(users)
    .values({ username: `vet-${++seq}`, role: "vet" })
    .returning();
  const [booking] = await db
    .insert(bookings)
    .values({ catId, vetId: vet.id, packagePrice: 150000, status: "booked" })
    .returning();
  const [action] = await db
    .insert(agentActions)
    .values({ action: "payout", reason: "test", status: "done" })
    .returning();
  await db.insert(payouts).values({
    catId,
    bookingId: booking.id,
    payeeUserId: vet.id,
    amount,
    fee,
    kind,
    actionId: action.id,
    status,
  });
}

const alloc = (catId: string, amount: number) =>
  withColonyLock((tx) => allocateToCat(tx, catId, amount));
const pool = () => withColonyLock((tx) => getPoolStatus(tx));

describe("ledger", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await closePool();
  });

  it("allocateToCat spans donations FIFO", async () => {
    const d1 = await donate(100000);
    const d2 = await donate(100000);
    const cat = await makeCat();
    const rows = await alloc(cat.id, 150000);
    expect(rows.map((r) => r.amount)).toEqual([100000, 50000]);
    expect(rows.map((r) => r.donationId)).toEqual([d1.id, d2.id]);
    expect(rows.every((r) => r.purpose === "vet" && r.catId === cat.id)).toBe(true);
  });

  it("resumes from the partially drawn donation", async () => {
    const d1 = await donate(100000);
    const d2 = await donate(100000);
    const cat = await makeCat();
    await alloc(cat.id, 60000);
    const rows = await alloc(cat.id, 80000);
    expect(rows.map((r) => [r.donationId, r.amount])).toEqual([
      [d1.id, 40000],
      [d2.id, 40000],
    ]);
  });

  it("allocateToCat throws InsufficientFunds and writes nothing when short", async () => {
    await donate(100000);
    const cat = await makeCat();
    await expect(alloc(cat.id, 100001)).rejects.toBeInstanceOf(InsufficientFunds);
    expect(await db.select().from(allocations)).toHaveLength(0);
  });

  it("rejects non-positive amounts", async () => {
    await donate(100000);
    const cat = await makeCat();
    await expect(alloc(cat.id, 0)).rejects.toThrow();
    await expect(alloc(cat.id, -5)).rejects.toThrow();
    await expect(returnSurplus_(cat.id, 0)).rejects.toThrow();
    await expect(returnSurplus_(cat.id, -5)).rejects.toThrow();
  });

  it("ignores pending and failed donations", async () => {
    await donate(100000, { status: "pending" });
    await donate(100000, { status: "failed" });
    const cat = await makeCat();
    const s = await pool();
    expect(s.grossIn).toBe(0);
    expect(s.available).toBe(0);
    await expect(alloc(cat.id, 1)).rejects.toBeInstanceOf(InsufficientFunds);
  });

  it("available covers payout fees even when donation remainders would not", async () => {
    await donate(100000);
    const cat = await makeCat();
    await alloc(cat.id, 50000);
    await addPayout(cat.id, "succeeded", 40000, 2000);
    // Per-donation remainder is 50000 but available is 48000.
    expect((await pool()).available).toBe(48000);
    await expect(alloc(cat.id, 49000)).rejects.toBeInstanceOf(InsufficientFunds);
    expect(await alloc(cat.id, 48000)).toHaveLength(1);
  });

  it("returnSurplus returns to the newest donations first, never below zero", async () => {
    const d1 = await donate(100000);
    const d2 = await donate(100000);
    const cat = await makeCat();
    await alloc(cat.id, 150000);
    await returnSurplus_(cat.id, 70000);
    const rows = (await db.select().from(allocations)).filter((r) => r.amount < 0);
    expect(rows.map((r) => [r.donationId, r.amount])).toEqual([
      [d2.id, -50000],
      [d1.id, -20000],
    ]);
    expect((await pool()).heldForCats).toBe(80000);
    // Returned money is allocatable again, oldest first.
    const other = await makeCat("Other");
    const again = await alloc(other.id, 120000);
    expect(again.map((r) => [r.donationId, r.amount])).toEqual([
      [d1.id, 20000],
      [d2.id, 100000],
    ]);
  });

  it("returnSurplus rejects more than the cat net allocation", async () => {
    await donate(100000);
    const cat = await makeCat();
    const other = await makeCat("Other");
    await alloc(cat.id, 30000);
    await alloc(other.id, 30000);
    await expect(returnSurplus_(cat.id, 30001)).rejects.toThrow();
    expect(await db.select().from(allocations)).toHaveLength(2);
  });

  it("returnSurplus cannot dip into succeeded or live payouts", async () => {
    await donate(100000);
    const cat = await makeCat();
    await alloc(cat.id, 80000);
    await addPayout(cat.id, "succeeded", 30000, 100);
    await expect(returnSurplus_(cat.id, 50001)).rejects.toThrow();
    await addPayout(cat.id, "queued", 20000, null, "balance");
    await expect(returnSurplus_(cat.id, 30001)).rejects.toThrow();
    await returnSurplus_(cat.id, 30000);
    expect((await pool()).heldForCats).toBe(0);
  });

  it("returnSurplus is allowed after a payout fails, and conservation holds", async () => {
    await donate(100000, { fee: 1000 });
    const cat = await makeCat();
    await alloc(cat.id, 80000);
    await addPayout(cat.id, "queued", 80000, null);
    await expect(returnSurplus_(cat.id, 1)).rejects.toThrow();
    await db.update(payouts).set({ status: "failed" });
    await returnSurplus_(cat.id, 80000);
    const s = await pool();
    expect(s.available).toBe(100000);
    expect(s.heldForCats).toBe(0);
    expect(s.grossIn).toBe(
      s.paypalFees + s.vetPaid + s.payoutFees + s.heldForCats + s.reservedPayouts + s.available,
    );
  });

  it("buckets payout statuses", async () => {
    await donate(1000000, { fee: 10000 });
    const cat = await makeCat();
    await alloc(cat.id, 500000);
    await addPayout(cat.id, "succeeded", 100000, 500, "deposit");
    await addPayout(cat.id, "succeeded", 50000, 300, "balance");
    for (const st of ["awaiting_approval", "queued", "sent", "needs_review"]) {
      await addPayout(cat.id, st, 1000, 99);
    }
    await addPayout(cat.id, "failed", 7000, 77);
    await addPayout(cat.id, "rejected", 7000, null);
    const s = await pool();
    expect(s.vetPaid).toBe(150000);
    expect(s.payoutFees).toBe(800);
    expect(s.reservedPayouts).toBe(4000);
    expect(s.heldForCats).toBe(500000 - 150000 - 4000);
  });

  it("sums above 2^31 without overflow", async () => {
    await donate(2_000_000_000, { fee: 100 });
    await donate(2_000_000_000, { fee: 100 });
    const cat = await makeCat();
    await alloc(cat.id, 1_500_000_000);
    await alloc(cat.id, 1_500_000_000);
    const s = await pool();
    expect(s.grossIn).toBe(4_000_000_200);
    expect(s.paypalFees).toBe(200);
    expect(s.heldForCats).toBe(3_000_000_000);
    expect(s.available).toBe(1_000_000_000);
    expect(Number.isSafeInteger(s.grossIn)).toBe(true);
  });

  it("conservation holds across the lifecycle", async () => {
    await donate(100000, { fee: 3000 });
    await donate(200000, { fee: 5000 });
    await donate(50000, { status: "pending" });
    const a = await makeCat("A");
    const b = await makeCat("B");
    const check = async () => {
      const s = await pool();
      expect(s.grossIn).toBe(
        s.paypalFees + s.vetPaid + s.payoutFees + s.heldForCats + s.reservedPayouts + s.available,
      );
      expect(s.heldForCats).toBeGreaterThanOrEqual(0);
      expect(s.available).toBeGreaterThanOrEqual(0);
      return s;
    };
    await check();
    await alloc(a.id, 150000);
    await alloc(b.id, 100000);
    await check();
    await addPayout(a.id, "succeeded", 45000, 400);
    await addPayout(a.id, "queued", 105000, null, "balance");
    await check();
    await addPayout(b.id, "failed", 30000, 100);
    await returnSurplus_(b.id, 20000);
    const s = await check();
    expect(s.grossIn).toBe(308000);
    expect(s.paypalFees).toBe(8000);
    expect(s.vetPaid).toBe(45000);
    expect(s.payoutFees).toBe(400);
    expect(s.reservedPayouts).toBe(105000);
    expect(s.heldForCats).toBe(250000 - 20000 - 45000 - 105000);
    expect(s.available).toBe(300000 - 230000 - 400);
    expect(await db.select().from(cats).where(eq(cats.id, a.id))).toHaveLength(1);
  });
});

function returnSurplus_(catId: string, amount: number) {
  return withColonyLock((tx) => returnSurplus(tx, catId, amount));
}

describe("ledger names", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  it("a demo account prints as A neighbour (and a demo vet as A partner vet), a real name is kept", async () => {
    const [demo] = await db.insert(users).values({ username: "demo_neighbour", role: "donor" }).returning();
    const [real] = await db.insert(users).values({ username: "real_donor", role: "donor" }).returning();
    await db.insert(donations).values([
      { userId: demo.id, gross: 10000, paypalFee: 0, net: 10000, paypalOrderId: "O-D", status: "captured" },
      { userId: real.id, gross: 10000, paypalFee: 0, net: 10000, paypalOrderId: "O-R", status: "captured" },
    ]);
    const cat = await makeCat();
    const [vet] = await db.insert(users).values({ username: "demo_vet", role: "vet" }).returning();
    const [booking] = await db.insert(bookings).values({ catId: cat.id, vetId: vet.id, packagePrice: 150000, status: "booked" }).returning();
    const [action] = await db.insert(agentActions).values({ action: "payout", reason: "test", status: "done" }).returning();
    await db.insert(payouts).values({ catId: cat.id, bookingId: booking.id, payeeUserId: vet.id, amount: 1000, fee: 0, kind: "deposit", actionId: action.id, status: "succeeded" });
    const who = (await getLedger()).map((r) => r.who);
    expect(JSON.stringify(who)).not.toContain("demo_");
    expect(who).toContain("A neighbour");
    expect(who).toContain("A partner vet");
    expect(who).toContain("real_donor");
  });
});
