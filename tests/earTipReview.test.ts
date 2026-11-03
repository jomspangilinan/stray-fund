import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db, withColonyLock } from "../src/server/db/client";
import { agentActions, cats, earTipFlags, payouts, reviewRequests, treatments, users, wakeups } from "../src/server/db/schema";
import { runAction } from "../src/server/caretaker";
import { RateLimited } from "../src/server/spot";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { assertUnderFlagLimit, setEarTipFlag } from "../src/server/earTipFlags";
import { getCatCard, listAgentActions, publicAgentAction } from "../src/server/public";
import { getCatThanks, getHomeThanks } from "../src/server/thanks";
import { earTipAskable } from "../src/lib/catState";
import { truncateAll } from "./helpers/db";
import { addPayout, fundCat, makeBooking, makeCaretaker, makeVet } from "./helpers/payoutFixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { SESSION_COOKIE, signSession } from "../src/server/session";
import { POST as flagPost } from "../src/app/api/cats/[id]/ear-tip/route";

let seq = 0;
async function makeUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ username: `neighbour_${Date.now()}_${++seq}`, role: "donor", ...over }).returning();
  return u;
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "spotted", ...over }).returning();
  return c;
}
const catRow = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0];
const flagsOf = (catId: string) => db.select().from(earTipFlags).where(eq(earTipFlags.catId, catId));
const actionsNamed = async (name: string) => (await db.select().from(agentActions)).filter((a) => a.action === name);
const openReviews = async () => (await db.select().from(reviewRequests)).filter((r) => r.status === "open");

/** A cat two neighbours said was already neutered, with no money and no vet record. */
async function flagNeutered() {
  const cat = await makeCat();
  const [a, b] = [await makeUser(), await makeUser()];
  await setEarTipFlag(cat.id, a.id, "yes");
  await setEarTipFlag(cat.id, b.id, "yes");
  expect((await catRow(cat.id)).status).toBe("neutered");
  return { cat, a, b, care: await makeCaretaker() };
}
const undo = (careId: string, catId: string) => runAction("cat_undo_neutered", careId, { catId });

beforeEach(async () => {
  await truncateAll();
  jar.clear();
});
afterAll(closePool);

describe("a caretaker puts a wrongly neutered cat back in the queue", () => {
  it("queues the cat, wakes the treasurer, audits it, and drops the Yes answers that caused it", async () => {
    const { cat, care } = await flagNeutered();
    const out = await undo(care.id, cat.id);
    expect(out).toMatchObject({ ok: true, status: 200 });
    const row = await catRow(cat.id);
    expect(row.status).toBe("queued");
    expect(row.earTipped).toBe(false);
    expect(row.queuedAt).not.toBeNull();
    expect((await db.select().from(wakeups)).map((w) => w.kind)).toEqual(["cat_queued"]);
    expect(await flagsOf(cat.id)).toHaveLength(0);
    const [audit] = await actionsNamed("cat_updated");
    expect(audit.approvedBy).toBe(care.id);
    expect(audit.inputs).toMatchObject({ catId: cat.id, change: "neutered_undone", from: "neutered" });
  });

  it("sticks: the same people answering Yes again cannot flip it back", async () => {
    const { cat, a, b, care } = await flagNeutered();
    await undo(care.id, cat.id);
    await setEarTipFlag(cat.id, a.id, "yes");
    expect((await catRow(cat.id)).status).toBe("queued");
    await setEarTipFlag(cat.id, b.id, "yes");
    const row = await catRow(cat.id);
    expect(row.status).toBe("queued");
    expect(row.earTipped).toBe(false);
    // The new answers still get a person to look.
    expect(await openReviews()).toHaveLength(1);
    // And the old ones earn no thanks for a call that was overruled.
    expect((await getCatThanks(cat.id)).filter((t) => t.text.includes("ear-tip"))).toHaveLength(0);
  });

  it("refuses with 409 when the cat has a neuter treatment, and changes nothing", async () => {
    const { cat, care } = await flagNeutered();
    await db.insert(treatments).values({ catId: cat.id, type: "neuter", date: "2026-11-01" });
    expect(await undo(care.id, cat.id)).toMatchObject({ ok: false, status: 409 });
    expect((await catRow(cat.id)).status).toBe("neutered");
    expect(await flagsOf(cat.id)).toHaveLength(2);
    expect(await actionsNamed("cat_updated")).toHaveLength(0);
  });

  it("refuses with 409 when money is allocated to the cat", async () => {
    const { cat, care } = await flagNeutered();
    await fundCat(cat.id, 150000);
    expect(await undo(care.id, cat.id)).toMatchObject({ ok: false, status: 409 });
    expect((await catRow(cat.id)).status).toBe("neutered");
    expect(await flagsOf(cat.id)).toHaveLength(2);
  });

  it("refuses with 409 when a payout is on record", async () => {
    const { cat, care } = await flagNeutered();
    const vet = await makeVet();
    const booking = await makeBooking(cat.id, vet.id);
    await addPayout({ cat, vet, booking }, { amount: 45000, status: "succeeded", batchId: `b-${++seq}` });
    expect(await db.select().from(payouts)).toHaveLength(1);
    expect(await undo(care.id, cat.id)).toMatchObject({ ok: false, status: 409 });
    expect((await catRow(cat.id)).status).toBe("neutered");
  });

  it("refuses with 409 when the cat is not marked neutered, and 404 for no such cat", async () => {
    const care = await makeCaretaker();
    for (const status of ["spotted", "queued", "in_care", "adoptable"]) {
      const cat = await makeCat({ status });
      expect(await undo(care.id, cat.id)).toMatchObject({ ok: false, status: 409 });
      expect((await catRow(cat.id)).status).toBe(status);
    }
    expect(await undo(care.id, "00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, status: 404 });
  });

  it("lists on the desk only cats the action would accept", async () => {
    const { cat } = await flagNeutered();
    const withVet = await makeCat({ status: "neutered", earTipped: true });
    await db.insert(treatments).values({ catId: withVet.id, type: "neuter", date: "2026-11-01" });
    const funded = await makeCat({ status: "neutered", earTipped: true });
    await fundCat(funded.id, 150000);
    const spotted = await makeCat();
    const listed = (await getCaretakerQueue()).neuteredWithoutRecord.map((c) => c.id);
    expect(listed).toEqual([cat.id]);
    expect(listed).not.toContain(spotted.id);
  });
});

describe("the ear-tip answer stays private", () => {
  it("never puts a username in thanks, the feed or the card once a cat is settled", async () => {
    const cat = await makeCat();
    const names = ["Mitzi_Visible", "Pogi_Visible"];
    const people = [];
    for (const username of names) people.push(await makeUser({ username, showNameInThanks: true }));
    for (const p of people) await setEarTipFlag(cat.id, p.id, "yes");
    expect((await catRow(cat.id)).status).toBe("neutered");

    const thanks = await getCatThanks(cat.id);
    expect(thanks.filter((t) => t.text.includes("ear-tip"))).toHaveLength(2);
    const reads = JSON.stringify([thanks, await getHomeThanks(), await listAgentActions(), await getCatCard(cat.id)]);
    for (const n of names) expect(reads).not.toContain(n);
    for (const p of people) expect(reads).not.toContain(p.id);
    expect(thanks.filter((t) => t.text.includes("ear-tip")).every((t) => t.name === "A neighbour" && t.badges.length === 0)).toBe(true);
  });

  it("settled-as-not-tipped is private too", async () => {
    const cat = await makeCat();
    const people = [await makeUser({ username: "Nono_Visible", showNameInThanks: true }), await makeUser({ username: "Nini_Visible", showNameInThanks: true })];
    for (const p of people) await setEarTipFlag(cat.id, p.id, "no");
    const reads = JSON.stringify([await getCatThanks(cat.id), await getHomeThanks(), await listAgentActions()]);
    expect(reads).not.toMatch(/_Visible/);
  });
});

describe("public feed and audit of flag moves", () => {
  it("labels a confirmed ear-tip", () => {
    const row = publicAgentAction({ id: "x", action: "ear_tip_confirmed", reason: "r", amount: null, status: "done", paypalRef: null, createdAt: new Date(), cat: null });
    expect(row.action).not.toBe("Treasurer action");
  });

  it("writes one audit row per real move, and none for who answered in public", async () => {
    const cat = await makeCat();
    const a = await makeUser({ username: "Audit_Visible", showNameInThanks: true });
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, a.id, null);
    const rows = await actionsNamed("ear_tip_answered");
    expect(rows).toHaveLength(3);
    expect(rows[0].inputs).toMatchObject({ catId: cat.id });
    const feed = JSON.stringify(await listAgentActions());
    expect(feed).not.toContain("Audit_Visible");
    expect(feed).not.toContain(a.id);
    expect(feed).not.toMatch(/"yes"|"no"/);
  });

  it("keeps flag moves out of the public feed, so the latest money action stays on top", async () => {
    const cat = await makeCat();
    await fundCat(cat.id, 150000);
    await db.insert(agentActions).values({ action: "fund_cat", reason: "Funded a cat.", status: "done", inputs: { catId: cat.id } });
    const a = await makeUser();
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, a.id, null);
    expect(await actionsNamed("ear_tip_answered")).toHaveLength(2);
    const feed = await listAgentActions();
    expect(feed.map((r) => r.action)).toEqual(["Funded a cat"]);
    expect((await listAgentActions(1))[0].action).toBe("Funded a cat");
  });

  it("still counts flag moves for the rate limit", async () => {
    const cat = await makeCat();
    const a = await makeUser();
    for (let i = 0; i < 10; i++) await setEarTipFlag(cat.id, a.id, i % 2 ? "yes" : "no");
    await expect(assertUnderFlagLimit(a.id)).rejects.toBeInstanceOf(RateLimited);
    await expect(assertUnderFlagLimit((await makeUser()).id)).resolves.toBeUndefined();
  });

  it("names the cat in a disagreement review", async () => {
    const cat = await makeCat({ name: "Kuting" });
    await setEarTipFlag(cat.id, (await makeUser()).id, "yes");
    await setEarTipFlag(cat.id, (await makeUser()).id, "no");
    const [review] = await openReviews();
    expect(review.reason).toContain("Kuting");
  });

  it("asks about a cat from spotted through in care, and no later", () => {
    for (const s of ["spotted", "queued", "funded", "booked", "in_care"]) expect(earTipAskable(s), s).toBe(true);
    for (const s of ["neutered", "adoptable", "adopted"]) expect(earTipAskable(s), s).toBe(false);
  });
});

describe("POST /api/cats/[id]/ear-tip limits", () => {
  const post = (id: string, body: unknown) =>
    flagPost(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });
  async function signIn(u: { id: string; username: string }) {
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: "donor", username: u.username }));
  }

  it("answers an unchanged answer without any write and without the colony lock", async () => {
    const cat = await makeCat();
    const a = await makeUser();
    await signIn(a);
    expect((await post(cat.id, { answer: "no" })).status).toBe(200);
    const before = (await db.select().from(agentActions)).length;
    const stamp = (await flagsOf(cat.id))[0].createdAt.getTime();
    // Hold the lock: a request that needed it would hang here.
    await withColonyLock(async () => {
      const res = await post(cat.id, { answer: "no" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ answer: "no" });
      const none = await makeCat();
      expect((await post(none.id, { answer: "unsure" })).status).toBe(200);
    });
    expect((await db.select().from(agentActions)).length).toBe(before);
    expect((await flagsOf(cat.id))[0].createdAt.getTime()).toBe(stamp);
  });

  it("refuses with 429 after too many changes in a minute, before the colony lock", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    for (let i = 0; i < 10; i++) expect((await post(cat.id, { answer: i % 2 ? "yes" : "no" })).status).toBe(200);
    await withColonyLock(async () => {
      expect((await post(cat.id, { answer: "yes" })).status).toBe(429);
    });
    expect(await flagsOf(cat.id)).toHaveLength(1);
  });
});
