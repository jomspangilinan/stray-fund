import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import {
  agentActions,
  allocations,
  bookings,
  cats,
  donations,
  receipts,
  sightings,
  treatments,
  users,
} from "../src/server/db/schema";
import { COLONY } from "../src/lib/config";
import { badgesOf, BADGE_LABEL, getBadgesFor, getCatThanks, getHomeThanks } from "../src/server/thanks";
import { truncateAll } from "./helpers/db";
import { eq } from "drizzle-orm";

beforeEach(truncateAll);
afterAll(closePool);

let n = 0;
const mkUser = async (patch: Partial<typeof users.$inferInsert> = {}) =>
  (await db.insert(users).values({ username: `neighbour_${++n}`, role: "donor", ...patch }).returning())[0];
const mkCat = async (name = `Cat${++n}`, patch: Partial<typeof cats.$inferInsert> = {}) =>
  (await db.insert(cats).values({ name, areaName: COLONY.area_name, exactLat: 10.987654321, ...patch }).returning())[0];
const ago = (m: number) => new Date(Date.now() - m * 60_000);
const spot = (userId: string, catId: string, state = "matched", minutesAgo = 10) =>
  db.insert(sightings).values({ catId, originalKey: `originals/${++n}.jpg`, caughtByUserId: userId, state, createdAt: ago(minutesAgo) });
async function fund(userId: string, catId: string, amount: number, minutesAgo = 10, status = "captured") {
  const [d] = await db
    .insert(donations)
    .values({ userId, gross: amount, paypalFee: 0, net: amount, paypalOrderId: `o${++n}`, status })
    .returning();
  await db.insert(allocations).values({ donationId: d.id, catId, purpose: "vet", amount, createdAt: ago(minutesAgo) });
  return d;
}

describe("cat thanks", () => {
  it("credits an accepted spot, and the first spotter of the cat", async () => {
    const a = await mkUser();
    const b = await mkUser();
    const c = await mkCat();
    await spot(a.id, c.id, "new_cat", 60);
    await spot(b.id, c.id, "matched", 30);
    const t = await getCatThanks(c.id);
    expect(t.map((x) => [x.name, x.text])).toEqual([
      [b.username, "spotted"],
      [a.username, "spotted first"],
    ]);
  });

  it("earns nothing from a rejected, pending or unresolved sighting", async () => {
    const u = await mkUser();
    const c = await mkCat();
    for (const s of ["rejected", "pending", "needs_review"]) await spot(u.id, c.id, s);
    expect(await getCatThanks(c.id)).toEqual([]);
    expect(await getBadgesFor(u.id)).toEqual([]);
    expect(await getHomeThanks()).toEqual([]);
  });

  it("credits funding only from a captured, net positive gift, and shows no amount", async () => {
    const real = await mkUser();
    const pending = await mkUser();
    const refunded = await mkUser();
    const c = await mkCat();
    await fund(real.id, c.id, 123_400);
    await fund(pending.id, c.id, 5000, 5, "pending");
    const d = await fund(refunded.id, c.id, 5000);
    await db.insert(allocations).values({ donationId: d.id, catId: c.id, purpose: "return", amount: -5000 });
    const t = await getCatThanks(c.id);
    expect(t.map((x) => [x.name, x.text])).toEqual([[real.username, "helped fund"]]);
    expect(JSON.stringify(t)).not.toMatch(/1234|123400|123,400|amount|peso|PHP/i);
  });

  it("never orders by amount", async () => {
    const small = await mkUser();
    const big = await mkUser();
    const c = await mkCat();
    await fund(big.id, c.id, 900_000, 60);
    await fund(small.id, c.id, 10_000, 20);
    expect((await getCatThanks(c.id)).map((x) => x.name)).toEqual([small.username, big.username]);
    await truncateAll();
    const s2 = await mkUser();
    const b2 = await mkUser();
    const c2 = await mkCat();
    await fund(s2.id, c2.id, 10_000, 60);
    await fund(b2.id, c2.id, 900_000, 20);
    expect((await getCatThanks(c2.id)).map((x) => x.name)).toEqual([b2.username, s2.username]);
  });

  it("credits a vet only for verified evidence", async () => {
    const vet = await mkUser({ role: "vet" });
    const c = await mkCat();
    const [b] = await db.insert(bookings).values({ catId: c.id, vetId: vet.id, packagePrice: 150000, status: "completed" }).returning();
    const [b2] = await db.insert(bookings).values({ catId: c.id, vetId: vet.id, packagePrice: 150000, status: "confirmed" }).returning();
    await db.insert(receipts).values({ bookingId: b2.id, fileKey: "originals/r1.jpg", sha256: "s1", verification: "needs_review" });
    expect(await getCatThanks(c.id)).toEqual([]);
    await db.insert(receipts).values({ bookingId: b.id, fileKey: "originals/r2.jpg", sha256: "s2", verification: "verified" });
    expect((await getCatThanks(c.id)).map((x) => x.text)).toEqual(["gave vet care"]);
  });

  it("credits a caretaker who accepted evidence or marked a cat adopted", async () => {
    const ct = await mkUser({ role: "caretaker" });
    const c = await mkCat();
    await db.insert(agentActions).values({ action: "cat_updated", inputs: { catId: c.id, change: "adoptable" }, reason: "x", status: "done", approvedBy: ct.id, createdAt: ago(30) });
    expect(await getCatThanks(c.id)).toEqual([]);
    await db.insert(agentActions).values({ action: "cat_updated", inputs: { catId: c.id, change: "adopted" }, reason: "x", status: "done", approvedBy: ct.id, createdAt: ago(20) });
    await db.insert(agentActions).values({ action: "evidence_accepted", inputs: { catId: c.id }, reason: "x", status: "done", approvedBy: ct.id, createdAt: ago(10) });
    expect((await getCatThanks(c.id)).map((x) => x.text)).toEqual(["checked vet care", "marked adopted"]);
  });

  it("caps at 6, newest first, and carries only name, text and badges", async () => {
    const c = await mkCat();
    for (let i = 0; i < 8; i++) await spot((await mkUser()).id, c.id, "matched", 100 - i);
    const t = await getCatThanks(c.id);
    expect(t).toHaveLength(6);
    expect(Object.keys(t[0]).sort()).toEqual(["badges", "name", "text"]);
    expect(JSON.stringify(t)).not.toMatch(/10\.98|originals|exact|@/);
  });

  it("shows A neighbour, and no badges, when someone opts out, everywhere", async () => {
    const hidden = await mkUser({ showNameInThanks: false });
    const c = await mkCat();
    await spot(hidden.id, c.id, "new_cat", 5);
    const card = await getCatThanks(c.id);
    expect(card[0].name).toBe("A neighbour");
    expect(card[0].badges).toEqual([]);
    const home = await getHomeThanks();
    expect(home[0].name).toBe("A neighbour");
    expect(JSON.stringify([card, home])).not.toContain(hidden.username);
    // Their own view still has their badges.
    expect(await getBadgesFor(hidden.id)).toContain(BADGE_LABEL.first_spot);
    await db.update(users).set({ showNameInThanks: true }).where(eq(users.id, hidden.id));
    expect((await getCatThanks(c.id))[0].name).toBe(hidden.username);
  });
});

describe("home thanks", () => {
  it("lists each person once, by their most recent verified action, never by count", async () => {
    const busy = await mkUser();
    const once = await mkUser();
    const c = await mkCat("Muning");
    for (let i = 0; i < 6; i++) await spot(busy.id, c.id, "matched", 200 + i);
    await spot(once.id, c.id, "matched", 5);
    const t = await getHomeThanks();
    expect(t.map((x) => x.name)).toEqual([once.username, busy.username]);
    expect(t[0].text).toBe("spotted Muning");
  });

  it("carries no totals, ranks or amounts", async () => {
    const u = await mkUser();
    const c = await mkCat();
    await fund(u.id, c.id, 777_700);
    const text = JSON.stringify(await getHomeThanks());
    expect(text).not.toMatch(/7777|777700|total|rank|top|most/i);
  });
});

describe("badges", () => {
  it("are earned from verified care and never from money size", () => {
    expect(badgesOf({ spots: 0, helpedNeutered: false, helpedHome: false })).toEqual([]);
    expect(badgesOf({ spots: 1, helpedNeutered: false, helpedHome: false })).toEqual(["first_spot"]);
    expect(badgesOf({ spots: 5, helpedNeutered: false, helpedHome: false })).toEqual(["first_spot", "spots_5"]);
    expect(badgesOf({ spots: 25, helpedNeutered: true, helpedHome: true })).toEqual([
      "first_spot",
      "spots_5",
      "spots_25",
      "neutered",
      "home",
    ]);
  });

  it("count a funded cat that was neutered or adopted, the same for every gift size", async () => {
    const small = await mkUser();
    const big = await mkUser();
    const c1 = await mkCat("A", { status: "neutered" });
    const c2 = await mkCat("B", { status: "adopted" });
    await db.insert(treatments).values([
      { catId: c1.id, type: "neuter", date: "2026-10-01" },
      { catId: c2.id, type: "neuter", date: "2026-10-01" },
    ]);
    await fund(small.id, c1.id, 100);
    await fund(big.id, c1.id, 5_000_000);
    await fund(big.id, c2.id, 5_000_000);
    expect(await getBadgesFor(small.id)).toEqual([BADGE_LABEL.neutered]);
    expect(await getBadgesFor(big.id)).toEqual([BADGE_LABEL.neutered, BADGE_LABEL.home]);
  });

  it("does not award the neutered badge for a cat found already ear-tipped", async () => {
    const u = await mkUser();
    const c = await mkCat("T", { status: "neutered", earTipped: true });
    await fund(u.id, c.id, 5000);
    expect(await getBadgesFor(u.id)).toEqual([]);
  });

  it("count distinct cats per day, so photos of one cat cannot farm a badge", async () => {
    const u = await mkUser();
    const c = await mkCat();
    for (let i = 0; i < 25; i++) await spot(u.id, c.id, "matched", 10);
    expect(await getBadgesFor(u.id)).toEqual([BADGE_LABEL.first_spot]);
  });

  it("show beside the name in thanks", async () => {
    const u = await mkUser();
    const c = await mkCat();
    await spot(u.id, c.id, "new_cat");
    expect((await getCatThanks(c.id))[0].badges).toEqual([BADGE_LABEL.first_spot]);
  });
});
