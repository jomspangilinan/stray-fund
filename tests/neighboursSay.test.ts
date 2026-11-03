import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, nameSuggestions, sightings, treatments, users } from "../src/server/db/schema";
import { runAction } from "../src/server/caretaker";
import { setEarTipFlag } from "../src/server/earTipFlags";
import { getImpact } from "../src/server/impact";
import { getCatCard, getGoalProgress, getHelpedCats, getYard, listCats, NEIGHBOURS_SAY_NEUTERED } from "../src/server/public";
import { helpedLine } from "../src/lib/helpedLine";
import { truncateAll } from "./helpers/db";
import { makeCaretaker } from "./helpers/payoutFixtures";

let seq = 0;
async function makeUser() {
  const [u] = await db.insert(users).values({ username: `neighbour_${Date.now()}_${++seq}`, role: "donor" }).returning();
  return u;
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "spotted", ...over }).returning();
  return c;
}
async function neighboursSay() {
  const cat = await makeCat();
  const [a, b] = [await makeUser(), await makeUser()];
  await setEarTipFlag(cat.id, a.id, "yes");
  await setEarTipFlag(cat.id, b.id, "yes");
  return cat;
}
const names = async (group: string) => (await listCats(group)).map((c) => c.id);
const neuteredStep = async (id: string) => (await getCatCard(id))!.cat.journey.find((j) => j.step === "Neutered")!;

beforeEach(truncateAll);
afterAll(closePool);

describe("two neighbours saying already neutered", () => {
  it("still moves the cat (the rule is unchanged) but the public words say neighbours think so", async () => {
    const cat = await neighboursSay();
    const row = (await db.select().from(cats).where(eq(cats.id, cat.id)))[0];
    expect(row).toMatchObject({ status: "neutered", earTipped: true, neuteredUnconfirmed: true });
    const card = (await getCatCard(cat.id))!.cat;
    expect(card.statusLabel).toBe(NEIGHBOURS_SAY_NEUTERED);
    expect(card.statusLabel).toBe("Neighbours say already neutered");
    const step = await neuteredStep(cat.id);
    expect(step.done).toBe(false);
    expect(step.note).toBe(NEIGHBOURS_SAY_NEUTERED);
  });

  it("is not in the Neutered list, is in Waiting, and is not counted by Home, the goal or Impact", async () => {
    const cat = await neighboursSay();
    expect(await names("neutered")).not.toContain(cat.id);
    expect(await names("waiting")).toContain(cat.id);
    expect(await names("all")).toContain(cat.id);
    expect((await getGoalProgress()).neutered).toBe(0);
    expect((await getImpact()).alreadyNeutered).toBe(0);
    const yard = await getYard(null);
    expect(yard.cats.find((c) => c.id === cat.id)).toMatchObject({ group: "waiting", marks: [] });
    expect(yard.goal.neutered).toBe(0);
  });

  it("turns into a plain Neutered cat, in the Neutered list and Impact, once a caretaker confirms", async () => {
    const cat = await neighboursSay();
    const care = await makeCaretaker();
    expect(await runAction("cat_set_ear_tip", care.id, { catId: cat.id, earTip: "present" })).toMatchObject({ ok: true, status: 200 });
    const row = (await db.select().from(cats).where(eq(cats.id, cat.id)))[0];
    expect(row.neuteredUnconfirmed).toBe(false);
    expect((await getCatCard(cat.id))!.cat.statusLabel).toBe("Neutered");
    expect((await neuteredStep(cat.id)).done).toBe(true);
    expect(await names("neutered")).toContain(cat.id);
    expect(await names("waiting")).not.toContain(cat.id);
    expect((await getImpact()).alreadyNeutered).toBe(1);
    // R43: one neutered count. A caretaker-confirmed already-neutered cat is in the goal and in Impact's total.
    expect((await getGoalProgress()).neutered).toBe(1);
    expect((await getImpact()).catsNeutered).toBe(1);
  });

  it("goes back to Waiting words when a caretaker puts it back in the queue", async () => {
    const cat = await neighboursSay();
    const care = await makeCaretaker();
    await runAction("cat_undo_neutered", care.id, { catId: cat.id });
    const row = (await db.select().from(cats).where(eq(cats.id, cat.id)))[0];
    expect(row).toMatchObject({ status: "queued", neuteredUnconfirmed: false });
    expect((await getCatCard(cat.id))!.cat.statusLabel).toBe("Waiting for funding");
  });

  it("never says neighbours say for a cat a vet neutered, and the goal counts it", async () => {
    const cat = await makeCat({ status: "neutered", earTipped: true });
    await db.insert(treatments).values({ catId: cat.id, type: "neuter", date: "2026-11-01" });
    expect((await getCatCard(cat.id))!.cat.statusLabel).toBe("Neutered");
    expect((await neuteredStep(cat.id)).done).toBe(true);
    expect((await getGoalProgress()).neutered).toBe(1);
    expect(await names("neutered")).toContain(cat.id);
  });

  it("home, cats and the card agree: the goal equals the vet-recorded cats and the Neutered list holds no unconfirmed cat", async () => {
    const said = await neighboursSay();
    const vet = await makeCat({ status: "neutered", earTipped: true });
    await db.insert(treatments).values({ catId: vet.id, type: "neuter", date: "2026-11-01" });
    expect((await getGoalProgress()).neutered).toBe(1);
    expect(await names("neutered")).toEqual([vet.id]);
    expect(await names("waiting")).toEqual([said.id]);
  });
});

describe("Cats I've helped", () => {
  async function spot(userId: string, catId: string, state = "matched") {
    await db.insert(sightings).values({ catId, originalKey: `originals/${++seq}.jpg`, caughtByUserId: userId, state });
  }

  it("lists cats I spotted, cats an approved name of mine went to, and cats I gave to, each once", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const spotted = await makeCat();
    const named = await makeCat();
    const gave = await makeCat({ status: "queued" });
    const both = await makeCat();
    const theirs = await makeCat();
    await spot(me.id, spotted.id);
    await spot(me.id, spotted.id, "new_cat");
    await spot(me.id, both.id);
    await spot(other.id, theirs.id);
    await db.insert(nameSuggestions).values({ catId: named.id, requesterId: me.id, name: "Mochi", status: "approved" });
    await db.insert(nameSuggestions).values({ catId: theirs.id, requesterId: me.id, name: "Kiko", status: "pending" });
    await db.insert(nameSuggestions).values({ catId: theirs.id, requesterId: me.id, name: "Kiko2", status: "dismissed" });
    await fundFor(me.id, gave.id, 50000);
    await fundFor(me.id, both.id, 20000);

    const mine = await getHelpedCats(me.id);
    const byId = new Map(mine.map((e) => [e.cat.id, e]));
    expect([...byId.keys()].sort()).toEqual([spotted.id, named.id, gave.id, both.id].sort());
    expect(mine).toHaveLength(4);
    expect(byId.get(spotted.id)).toMatchObject({ spotted: true, named: false, amount: 0 });
    expect(byId.get(named.id)).toMatchObject({ spotted: false, named: true, amount: 0 });
    expect(byId.get(gave.id)).toMatchObject({ spotted: false, named: false, amount: 50000 });
    expect(byId.get(both.id)).toMatchObject({ spotted: true, amount: 20000 });
    // Cats someone else spotted, or only a pending or dismissed name of mine, are not mine.
    expect(byId.has(theirs.id)).toBe(false);
  });

  it("ignores a sighting that was not accepted, and shows nothing of anyone else's help", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const c = await makeCat();
    await spot(me.id, c.id, "needs_review");
    await spot(me.id, c.id, "rejected");
    expect(await getHelpedCats(me.id)).toEqual([]);
    await spot(other.id, c.id);
    expect(await getHelpedCats(me.id)).toEqual([]);
    expect(await getHelpedCats(other.id)).toHaveLength(1);
  });

  it("says what the person did, in order, with the real amount", () => {
    expect(helpedLine({ spotted: true, named: false, amount: 0 })).toBe("You spotted");
    expect(helpedLine({ spotted: false, named: true, amount: 0 })).toBe("You named");
    expect(helpedLine({ spotted: false, named: false, amount: 50000 })).toBe("You gave ₱500");
    expect(helpedLine({ spotted: true, named: true, amount: 20000 })).toBe("You spotted, named and gave ₱200");
    expect(helpedLine({ spotted: true, named: false, amount: 12345 })).toBe("You spotted and gave ₱123.45");
  });
});

async function fundFor(userId: string, catId: string, amount: number) {
  const [d] = await db.insert(donations).values({ userId, gross: amount, paypalFee: 0, net: amount, paypalOrderId: `o${++seq}`, status: "captured" }).returning();
  await db.insert(allocations).values({ donationId: d.id, catId, purpose: "vet", amount });
}
