import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closePool } from "../src/server/db/client";
import {
  agentActions,
  allocations,
  bookings,
  cats,
  donations,
  meals,
  payouts,
  donationReversals,
  treatments,
  users,
} from "../src/server/db/schema";
import { getPoolStatus } from "../src/server/ledger";
import { getImpact, getLedger } from "../src/server/impact";
import { conservation, ledgerTotals } from "../src/lib/impact";
import { formatPeso } from "../src/lib/money";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);
afterAll(closePool);

const EMAIL = "impact.sentinel@example.test";
let seq = 0;

async function user(username: string, role: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ username, role, paypalEmail: EMAIL, ...extra }).returning();
  return u;
}

async function cat(name: string, status = "spotted", earTipped: boolean | null = null) {
  const [c] = await db.insert(cats).values({ name, areaName: "Brgy 1", status, earTipped }).returning();
  return c;
}

async function donate(gross: number, fee: number, userId: string | null, status = "captured", day = "2026-03-01") {
  seq += 1;
  const [d] = await db
    .insert(donations)
    .values({
      userId,
      gross,
      paypalFee: status === "pending" ? 0 : fee,
      net: status === "pending" ? 0 : gross - fee,
      paypalOrderId: `order-${seq}`,
      paypalCaptureId: status === "captured" ? `CAP-${seq}` : null,
      status,
      createdAt: new Date(`${day}T04:00:00Z`),
    })
    .returning();
  return d;
}

async function pay(
  c: { id: string },
  vet: { id: string },
  amount: number,
  fee: number | null,
  status: string,
  reason = "Waited longest",
  kind: "deposit" | "balance" = "deposit",
) {
  seq += 1;
  const [booking] = await db.insert(bookings).values({ catId: c.id, vetId: vet.id, packagePrice: 150000, status: "completed" }).returning();
  const [action] = await db
    .insert(agentActions)
    .values({
      action: "payout_deposit",
      reason,
      amount,
      status,
      inputs: { secret: "agentinputs-sentinel", gatewayError: "gatewayerror-sentinel" },
    })
    .returning();
  const [p] = await db
    .insert(payouts)
    .values({
      catId: c.id,
      bookingId: booking.id,
      payeeUserId: vet.id,
      amount,
      fee,
      kind,
      actionId: action.id,
      status,
      paypalItemId: status === "succeeded" ? `ITEM-${seq}` : null,
      lastGatewayError: "gatewayerror-sentinel",
      createdAt: new Date("2026-03-05T04:00:00Z"),
    })
    .returning();
  return p;
}

/** Donations of 2 x 1,000, one pending and one anonymous; payouts of every state. */
async function seedMix() {
  const donor = await user("neighbour_ana", "donor");
  const vet = await user("vet_clinic", "vet");
  const mimi = await cat("Mimi", "neutered");
  const kiko = await cat("Kiko", "booked");
  const d1 = await donate(100_000, 4_000, donor.id);
  const d2 = await donate(50_000, 2_500, null);
  await donate(30_000, 0, donor.id, "pending");
  await db.insert(allocations).values([
    { donationId: d1.id, catId: mimi.id, purpose: "vet", amount: 40_000 },
    { donationId: d2.id, catId: kiko.id, purpose: "vet", amount: 30_000 },
  ]);
  await pay(mimi, vet, 25_000, 100, "succeeded");
  await pay(kiko, vet, 10_000, null, "sent");
  await pay(kiko, vet, 5_000, null, "failed", "Retry later");
  return { donor, vet, mimi, kiko };
}

describe("impact counts", () => {
  it("come from treatments and statuses on a seeded mix", async () => {
    const vet = await user("vet_one", "vet");
    const a = await cat("A", "neutered");
    const b = await cat("B", "adopted");
    const c = await cat("C", "booked");
    await cat("D", "spotted");
    await cat("E", "queued");
    await db.insert(treatments).values([
      { catId: a.id, type: "neuter", date: "2026-02-01", vetId: vet.id },
      { catId: a.id, type: "vaccine", date: "2026-02-01", vetId: vet.id },
      { catId: b.id, type: "neuter", date: "2026-02-02", vetId: vet.id },
      { catId: b.id, type: "deworming", date: "2026-02-02", vetId: vet.id },
      { catId: b.id, type: "vaccine", date: "2026-02-02", vetId: vet.id },
      { catId: c.id, type: "deworming", date: "2026-02-03", vetId: vet.id },
    ]);
    await db.insert(meals).values([{ source: "feeder" }, { source: "feeder" }, { source: "feeder" }]);
    const impact = await getImpact();
    expect(impact).toMatchObject({
      catsNeutered: 2,
      catsVaccinated: 2,
      catsDewormed: 2,
      catsAdopted: 1,
      catsWaiting: 3,
      meals: 3,
    });
  });

  it("counts already ear-tipped cats in the one neutered number, and keeps the fund's own work apart", async () => {
    const vet = await user("vet_two", "vet");
    const fund = await cat("ByFund", "neutered", true);
    await cat("FoundTipped", "neutered", true);
    await cat("FoundTippedToo", "spotted", true);
    await cat("Open", "spotted", false);
    await db.insert(treatments).values({ catId: fund.id, type: "neuter", date: "2026-02-01", vetId: vet.id });
    const impact = await getImpact();
    // One number (R43): the cat the fund did plus the two caretaker-confirmed ones found tipped.
    expect(impact.catsNeutered).toBe(3);
    expect(impact.catsNeuteredByFund).toBe(1);
    expect(impact.alreadyNeutered).toBe(2);
  });
});

describe("conservation identity", () => {
  it("displays exactly, with in-flight money counted as held", async () => {
    await seedMix();
    const impact = await getImpact();
    const p = impact.pool;
    expect(p.grossIn).toBe(150_000);
    const c = conservation(p);
    expect(c.balanced).toBe(true);
    expect(c.text).toBe(
      `Donated ${formatPeso(150_000)} = PayPal fees ${formatPeso(6_500)} + paid to vets ${formatPeso(25_000)}` +
        ` + payout fees ${formatPeso(100)} + held for cats ${formatPeso(p.heldForCats + p.reservedPayouts)}` +
        ` + left in the pool ${formatPeso(p.available)}`,
    );
    // 150,000 = 6,500 + 25,000 + 100 + (70,000 - 25,000) + 73,400
    expect(c.parts.held).toBe(45_000);
    expect(c.parts.pool).toBe(73_400);
  });

  it("reports an imbalance instead of hiding it", () => {
    const c = conservation({
      grossIn: 1000, paypalFees: 0, vetPaid: 0, payoutFees: 0, heldForCats: 0, reservedPayouts: 0, available: 900, reversedGross: 0,
    });
    expect(c.balanced).toBe(false);
  });
});

describe("public ledger: the thanks switch (I5)", () => {
  it("shows A neighbour for a donor who turned the name off, on donations and on a refund of one, with every amount intact", async () => {
    const hidden = await user("quiet_donor_sentinel", "donor", { showNameInThanks: false });
    const shown = await user("open_donor", "donor", { showNameInThanks: true });
    const a = await donate(30_000, 1_500, hidden.id);
    await donate(20_000, 1_000, shown.id);
    await db.insert(donationReversals).values({
      donationId: a.id, kind: "refund", paypalRef: "RF-I5", grossDelta: -10_000, feeDelta: -500, netDelta: -9_500, basis: "breakdown",
    });
    const rows = await getLedger();
    const text = JSON.stringify(rows);
    expect(text).not.toContain("quiet_donor_sentinel");
    const mine = rows.filter((r) => r.type === "donation" || r.type === "refund");
    expect(mine.map((r) => [r.type, r.amount, r.who]).sort()).toEqual(
      [["donation", 20_000, "open_donor"], ["donation", 30_000, "A neighbour"], ["refund", -10_000, "A neighbour"]].sort(),
    );
    const t = ledgerTotals(rows);
    const pool = await db.transaction((tx) => getPoolStatus(tx));
    expect(t.donated).toBe(pool.grossIn);
  });

  it("names the donor again when they switch it back on", async () => {
    const u = await user("back_on", "donor", { showNameInThanks: false });
    await donate(10_000, 500, u.id);
    expect((await getLedger())[0].who).toBe("A neighbour");
    await db.update(users).set({ showNameInThanks: true }).where(eq(users.id, u.id));
    expect((await getLedger())[0].who).toBe("back_on");
  });
});

describe("public ledger", () => {
  it("has one row per donation and payout, with fees, and failed payouts marked failed", async () => {
    await seedMix();
    const rows = await getLedger();
    // Two captured donations (the pending one is left out) and three payouts.
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.type === "donation")).toHaveLength(2);
    const payoutRows = rows.filter((r) => r.type !== "donation");
    expect(payoutRows).toHaveLength(3);
    expect(payoutRows.find((r) => r.status === "failed")).toMatchObject({ amount: 5_000, reason: "Retry later" });
    const paid = payoutRows.find((r) => r.status === "succeeded");
    expect(paid).toMatchObject({ amount: 25_000, fee: 100, cat: "Mimi", paypalId: expect.stringMatching(/^ITEM-/), who: "vet_clinic" });
    expect(paid?.catId).toBeTruthy();
    const don = rows.filter((r) => r.type === "donation").find((r) => r.amount === 100_000);
    expect(rows.map((r) => r.date)).toEqual(["2026-03-05", "2026-03-05", "2026-03-05", "2026-03-01", "2026-03-01"]);
    expect(don).toMatchObject({ fee: 4_000, status: "captured", who: "neighbour_ana", paypalId: expect.stringMatching(/^CAP-/) });
  });

  it("shows a username only, Anonymous without a user, and never an email, input or gateway error", async () => {
    await seedMix();
    const rows = await getLedger();
    expect(rows.find((r) => r.amount === 50_000)?.who).toBe("Anonymous");
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ["amount", "cat", "catId", "date", "fee", "paypalId", "reason", "status", "type", "who"].sort(),
      );
    }
    const text = JSON.stringify(rows);
    for (const s of [EMAIL, "agentinputs-sentinel", "gatewayerror-sentinel", "@"]) {
      expect(text, `leaked ${s}`).not.toContain(s);
    }
  });

  it("reconciles by type with getPoolStatus on a seeded mix", async () => {
    await seedMix();
    const rows = await getLedger();
    const pool = await db.transaction((tx) => getPoolStatus(tx));
    const t = ledgerTotals(rows);
    expect(t.donated).toBe(pool.grossIn);
    expect(t.paypalFees).toBe(pool.paypalFees);
    expect(t.paidToVets).toBe(pool.vetPaid);
    expect(t.payoutFees).toBe(pool.payoutFees);
    expect(t.inFlight).toBe(pool.reservedPayouts);
  });
});

describe("ledger totals", () => {
  const row = (over: Partial<Parameters<typeof ledgerTotals>[0][number]>) => ({
    date: "2026-03-01", type: "donation", amount: 0, fee: 0, cat: null, catId: null, reason: null,
    paypalId: null, status: "captured", who: null, ...over,
  });

  it("are recomputed from whatever rows are passed, so a filter changes them", () => {
    const all = [
      row({ amount: 10_000, fee: 400 }),
      row({ amount: 20_000, fee: 800 }),
      row({ type: "vet_deposit", amount: 5_000, fee: 50, status: "succeeded" }),
      row({ type: "vet_balance", amount: 7_000, fee: null, status: "sent" }),
      row({ type: "vet_deposit", amount: 3_000, fee: null, status: "failed" }),
    ];
    expect(ledgerTotals(all)).toEqual({
      donated: 30_000, paypalFees: 1_200, paidToVets: 5_000, payoutFees: 50, inFlight: 7_000, count: 5,
    });
    expect(ledgerTotals(all.slice(0, 1))).toEqual({
      donated: 10_000, paypalFees: 400, paidToVets: 0, payoutFees: 0, inFlight: 0, count: 1,
    });
    expect(ledgerTotals([])).toEqual({ donated: 0, paypalFees: 0, paidToVets: 0, payoutFees: 0, inFlight: 0, count: 0 });
  });
});
