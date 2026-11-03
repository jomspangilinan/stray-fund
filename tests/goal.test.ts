import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, milestoneSeen, sightings, treatments, users } from "../src/server/db/schema";
import { COLONY } from "../src/lib/config";
import { goalPercent } from "../src/lib/goal";
import { getGoalProgress } from "../src/server/public";
import { getImpact } from "../src/server/impact";
import { celebrationText, confirmCelebrationSeen, findCelebration, markCelebrationSeen, milestonesFor } from "../src/server/milestones";
import { getHelpedCats, getHelpedEntries } from "../src/server/public";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);
afterAll(closePool);

let n = 0;
const mkCat = async (patch: Partial<typeof cats.$inferInsert> = {}) =>
  (await db.insert(cats).values({ name: `Cat${++n}`, areaName: COLONY.area_name, ...patch }).returning())[0];
const mkUser = async () => (await db.insert(users).values({ username: `u${++n}`, role: "donor" }).returning())[0];
const neuter = (catId: string) => db.insert(treatments).values({ catId, type: "neuter", date: "2026-10-01" });
async function donate(userId: string, catId: string, amount: number, status = "captured") {
  const [d] = await db
    .insert(donations)
    .values({ userId, gross: amount, paypalFee: 0, net: amount, paypalOrderId: `o${++n}`, status })
    .returning();
  await db.insert(allocations).values({ donationId: d.id, catId, purpose: "vet", amount });
  return d;
}

describe("goal", () => {
  it("has a placeholder goal of 30", () => {
    expect(COLONY.goalCats).toBe(30);
  });

  it("counts cats the fund neutered with a treatment, once each", async () => {
    const a = await mkCat({ status: "neutered" });
    const b = await mkCat({ status: "adopted" });
    await neuter(a.id);
    await neuter(a.id);
    await neuter(b.id);
    await db.insert(treatments).values({ catId: a.id, type: "vaccine", date: "2026-10-02" });
    expect(await getGoalProgress()).toEqual({ neutered: 2, goal: COLONY.goalCats, area: COLONY.area_name, percent: 7 });
  });

  it("counts a cat a caretaker confirmed as already neutered, but not one neighbours only said so about, nor a status alone (R43)", async () => {
    await mkCat({ status: "neutered", earTipped: true });
    await mkCat({ status: "neutered", earTipped: true, neuteredUnconfirmed: true });
    await mkCat({ status: "neutered" });
    const p = await getGoalProgress();
    expect(p.neutered).toBe(1);
    expect(p.percent).toBe(3);
  });

  it("is one number: Home goal, the Impact page and the sum of its parts agree, with one cat counted once", async () => {
    const a = await mkCat({ status: "neutered", earTipped: true });
    const b = await mkCat({ status: "adopted", earTipped: true });
    const c = await mkCat({ status: "neutered", earTipped: true });
    await mkCat({ status: "spotted", earTipped: false });
    await neuter(a.id); // both a fund treatment and a tipped ear: still one cat
    await neuter(b.id);
    void c;
    const goal = await getGoalProgress();
    const impact = await getImpact();
    expect(goal.neutered).toBe(3);
    expect(impact.catsNeutered).toBe(goal.neutered);
    expect(impact.alreadyNeutered).toBe(1);
    expect(impact.catsNeuteredByFund).toBe(2);
  });

  it("clamps the bar to the goal", () => {
    expect(goalPercent(0, 30)).toBe(0);
    expect(goalPercent(15, 30)).toBe(50);
    expect(goalPercent(45, 30)).toBe(100);
    expect(goalPercent(3, 0)).toBe(0);
  });
});

describe("milestones", () => {
  const entriesOf = async (userId: string) => getHelpedEntries(userId);

  it("celebrates a neutered cat the donor helped, once", async () => {
    const u = await mkUser();
    const c = await mkCat({ name: "Ningning", status: "neutered" });
    await neuter(c.id);
    await donate(u.id, c.id, 5000);
    const first = await findCelebration(u.id, await entriesOf(u.id));
    expect(first && celebrationText(first)).toBe("Ningning came home from the vet. You helped fund this.");
    // Showing it twice (a reload before the browser confirmed) is still the same note, nothing is lost.
    expect((await findCelebration(u.id, await entriesOf(u.id)))?.catId).toBe(c.id);
    expect(await db.select().from(milestoneSeen)).toHaveLength(0);
    expect(await confirmCelebrationSeen(u.id, await entriesOf(u.id), first!)).toBe(true);
    expect(await findCelebration(u.id, await entriesOf(u.id))).toBeNull();
    expect(await db.select().from(milestoneSeen)).toHaveLength(1);
  });

  it("celebrates adoption as its own moment, after the neutering one", async () => {
    const u = await mkUser();
    const c = await mkCat({ name: "Mingming", status: "adopted" });
    await neuter(c.id);
    await donate(u.id, c.id, 5000);
    const a = await findCelebration(u.id, await entriesOf(u.id));
    expect(a?.milestone).toBe("adopted");
    expect(a && celebrationText(a)).toBe("Mingming found a home. You helped fund this.");
    await markCelebrationSeen(u.id, a!);
    const b = await findCelebration(u.id, await entriesOf(u.id));
    expect(b?.milestone).toBe("neutered");
    await markCelebrationSeen(u.id, b!);
    expect(await findCelebration(u.id, await entriesOf(u.id))).toBeNull();
  });

  it("says nothing for a cat the donor did not help", async () => {
    const u = await mkUser();
    const other = await mkUser();
    const c = await mkCat({ status: "neutered" });
    await neuter(c.id);
    await donate(other.id, c.id, 5000);
    expect(await findCelebration(u.id, await entriesOf(u.id))).toBeNull();
  });

  it("says nothing when the donation was not captured or the allocation nets to zero", async () => {
    const u = await mkUser();
    const c1 = await mkCat({ status: "neutered" });
    const c2 = await mkCat({ status: "neutered" });
    await neuter(c1.id);
    await neuter(c2.id);
    await donate(u.id, c1.id, 5000, "pending");
    const d = await donate(u.id, c2.id, 5000);
    await db.insert(allocations).values({ donationId: d.id, catId: c2.id, purpose: "return", amount: -5000 });
    expect(await findCelebration(u.id, await entriesOf(u.id))).toBeNull();
  });

  it("does not say the vet neutered a cat that was found ear-tipped", async () => {
    const u = await mkUser();
    const c = await mkCat({ status: "neutered", earTipped: true });
    await donate(u.id, c.id, 5000);
    expect(await findCelebration(u.id, await entriesOf(u.id))).toBeNull();
  });

  it("needs a real neuter treatment, not a neutered status alone", async () => {
    const u = await mkUser();
    const c = await mkCat({ status: "neutered" });
    await donate(u.id, c.id, 5000);
    const [e] = await entriesOf(u.id);
    expect(milestonesFor(e.cat)).toEqual([]);
    expect(await findCelebration(u.id, [e])).toBeNull();
  });

  it("gives a waiting cat no milestone", async () => {
    const u = await mkUser();
    const c = await mkCat({ status: "queued" });
    await donate(u.id, c.id, 5000);
    const [e] = await entriesOf(u.id);
    expect(milestonesFor(e.cat)).toEqual([]);
    expect(await findCelebration(u.id, [e])).toBeNull();
  });

  it("refuses to mark a milestone that is not true for this donor", async () => {
    const u = await mkUser();
    const other = await mkUser();
    const c = await mkCat({ status: "neutered" });
    await neuter(c.id);
    await donate(other.id, c.id, 5000);
    expect(await confirmCelebrationSeen(u.id, await entriesOf(u.id), { catId: c.id, milestone: "neutered" })).toBe(false);
    const w = await mkCat({ status: "queued" });
    await donate(u.id, w.id, 5000);
    expect(await confirmCelebrationSeen(u.id, await entriesOf(u.id), { catId: w.id, milestone: "adopted" })).toBe(false);
    expect(await db.select().from(milestoneSeen)).toHaveLength(0);
  });

  it("is once even when two pages confirm at the same time", async () => {
    const u = await mkUser();
    const c = await mkCat({ status: "neutered" });
    await neuter(c.id);
    await donate(u.id, c.id, 5000);
    const entries = await entriesOf(u.id);
    const claim = { catId: c.id, milestone: "neutered" };
    const got = await Promise.all([confirmCelebrationSeen(u.id, entries, claim), confirmCelebrationSeen(u.id, entries, claim)]);
    expect(got.filter(Boolean)).toHaveLength(1);
  });
});

describe("getMissions", () => {
  it("builds missions from the data and clears one when a new sighting lands", async () => {
    const { getMissions } = await import("../src/server/public");
    const { sightings } = await import("../src/server/db/schema");
    const old = new Date(Date.now() - 6 * 86_400_000);
    const c = await mkCat({ name: "Muning", status: "queued", flags: ["pregnant"], earTipped: false, createdAt: old });
    const [s] = await db
      .insert(sightings)
      .values({ catId: c.id, originalKey: "originals/x.jpg", state: "matched", createdAt: old })
      .returning();
    let m = await getMissions();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ title: "Help find Muning", action: "spot", photoUrl: null });
    expect(m[0].detail).toMatch(/6 days ago, pregnant/);
    expect(JSON.stringify(m)).not.toMatch(/originals|exact|fuzzed/);
    await db.insert(sightings).values({ catId: c.id, originalKey: "originals/y.jpg", state: "matched" });
    m = await getMissions();
    expect(m).toEqual([]);
    expect(s.id).toBeTruthy();
  });

  it("uses the public photo only when ready", async () => {
    const { getMissions } = await import("../src/server/public");
    const { sightings } = await import("../src/server/db/schema");
    const c = await mkCat({ name: "Mingming", status: "adoptable" });
    await db.insert(sightings).values({
      catId: c.id,
      originalKey: "originals/a.jpg",
      publicKey: "photos/a.jpg",
      publicReady: false,
      state: "matched",
    });
    expect((await getMissions())[0].photoUrl).toBeNull();
    await db.insert(sightings).values({
      catId: c.id,
      originalKey: "originals/b.jpg",
      publicKey: "photos/b.jpg",
      publicReady: true,
      state: "matched",
    });
    expect((await getMissions())[0].photoUrl).toContain("photos/b.jpg");
  });
});

describe("Home with the spending rules row missing", () => {
  it("still loads, with the default package price", async () => {
    const { getHomeData } = await import("../src/server/public");
    await db.execute(sql`delete from guardrails`);
    const home = await getHomeData();
    expect(home.packagePrice).toBe(150_000);
  });
});

describe("Helped order is the same every time", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day));

  it("gifts first, biggest first, equal gifts newest cat first, then spotted cats newest first", async () => {
    const u = await mkUser();
    const old = await mkCat({ name: "OldGift", createdAt: at(1) });
    const fresh = await mkCat({ name: "NewGift", createdAt: at(9) });
    const big = await mkCat({ name: "BigGift", createdAt: at(3) });
    await donate(u.id, old.id, 5_000);
    await donate(u.id, fresh.id, 5_000);
    await donate(u.id, big.id, 9_000);
    const spottedOld = await mkCat({ name: "SpotOld", createdAt: at(2) });
    const spottedNew = await mkCat({ name: "SpotNew", createdAt: at(8) });
    const spottedMid = await mkCat({ name: "SpotMid", createdAt: at(5) });
    for (const c of [spottedMid, spottedOld, spottedNew]) {
      await db.insert(sightings).values({ catId: c.id, caughtByUserId: u.id, originalKey: `originals/00000000-0000-4000-8000-00000000000${++n % 10}.jpg`, state: "new_cat" });
    }
    const want = ["BigGift", "NewGift", "OldGift", "SpotNew", "SpotMid", "SpotOld"];
    for (let i = 0; i < 5; i++) expect((await getHelpedCats(u.id)).map((h) => h.cat.name)).toEqual(want);
  });
});
