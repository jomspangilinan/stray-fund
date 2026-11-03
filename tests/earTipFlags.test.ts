import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, earTipFlags, reviewRequests, treatments, users, wakeups } from "../src/server/db/schema";
import { createAgentTools } from "../src/server/agent/tools";
import { runAction } from "../src/server/caretaker";
import { setEarTipFlag } from "../src/server/earTipFlags";
import { getGoalProgress, getMissions } from "../src/server/public";
import { getCatThanks } from "../src/server/thanks";
import { getImpact } from "../src/server/impact";
import { truncateAll } from "./helpers/db";
import { FakeGateway, fundCat, makeCaretaker } from "./helpers/payoutFixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { SESSION_COOKIE, signSession } from "../src/server/session";
import { POST as flagPost } from "../src/app/api/cats/[id]/ear-tip/route";

let seq = 0;
async function makeUser(role = "donor") {
  const [u] = await db.insert(users).values({ username: `neighbour_${Date.now()}_${++seq}`, role }).returning();
  return u;
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db
    .insert(cats)
    .values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "spotted", ...over })
    .returning();
  return c;
}
const catRow = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0];
const wakeKinds = async () => (await db.select().from(wakeups)).map((w) => w.kind);
const openReviews = async () => (await db.select().from(reviewRequests)).filter((r) => r.status === "open");

beforeEach(async () => {
  await truncateAll();
  jar.clear();
});
afterAll(closePool);

describe("ear-tip flags and the queue rule", () => {
  it("one No does nothing to the cat", async () => {
    const cat = await makeCat();
    const a = await makeUser();
    await setEarTipFlag(cat.id, a.id, "no");
    const row = await catRow(cat.id);
    expect(row.status).toBe("spotted");
    expect(row.earTipped).toBeNull();
    expect(row.queuedAt).toBeNull();
    expect(await wakeKinds()).toEqual([]);
  });

  it("two different users saying No queue the cat once", async () => {
    const cat = await makeCat();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, b.id, "no");
    const row = await catRow(cat.id);
    expect(row.status).toBe("queued");
    expect(row.earTipped).toBe(false);
    expect(row.queuedAt).not.toBeNull();
    expect(await wakeKinds()).toEqual(["cat_queued"]);
    // A third No changes nothing and enqueues nothing more.
    await setEarTipFlag(cat.id, c.id, "no");
    expect(await wakeKinds()).toEqual(["cat_queued"]);
    expect((await catRow(cat.id)).status).toBe("queued");
  });

  it("the same user twice does not count twice", async () => {
    const cat = await makeCat();
    const a = await makeUser();
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, a.id, "no");
    expect(await db.select().from(earTipFlags).where(eq(earTipFlags.catId, cat.id))).toHaveLength(1);
    expect((await catRow(cat.id)).status).toBe("spotted");
  });

  it("the latest answer wins, so a changed mind moves the count", async () => {
    const cat = await makeCat();
    const [a, b] = [await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, b.id, "no");
    // a now says Yes and b says No: a disagreement, not two Nos.
    expect((await catRow(cat.id)).status).toBe("spotted");
    expect(await openReviews()).toHaveLength(1);
    const [row] = await db.select().from(earTipFlags).where(and(eq(earTipFlags.catId, cat.id), eq(earTipFlags.userId, a.id)));
    expect(row.value).toBe("yes");
  });

  it("Not sure takes the person's answer back", async () => {
    const cat = await makeCat();
    const a = await makeUser();
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, a.id, null);
    expect(await db.select().from(earTipFlags)).toHaveLength(0);
  });

  it("two different users saying Yes move the cat to neutered without crediting the fund", async () => {
    const cat = await makeCat();
    const [a, b] = [await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "yes");
    expect((await catRow(cat.id)).status).toBe("spotted");
    await setEarTipFlag(cat.id, b.id, "yes");
    const row = await catRow(cat.id);
    expect(row.status).toBe("neutered");
    expect(row.earTipped).toBe(true);
    expect(await db.select().from(treatments)).toHaveLength(0);
    expect((await getGoalProgress()).neutered).toBe(0);
    // Only neighbours said so, so Impact does not count it until a caretaker confirms.
    expect((await getImpact()).alreadyNeutered).toBe(0);
    expect(row.neuteredUnconfirmed).toBe(true);
    expect(await wakeKinds()).toEqual([]);
  });

  it("two Yes with money already set aside file a review instead of neutering", async () => {
    const cat = await makeCat();
    await fundCat(cat.id, 150000);
    const [a, b] = [await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, b.id, "yes");
    expect((await catRow(cat.id)).status).toBe("spotted");
    expect(await openReviews()).toHaveLength(1);
    expect(await db.select().from(allocations)).toHaveLength(1);
  });

  it("any disagreement files one review and leaves the status alone", async () => {
    const cat = await makeCat();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, b.id, "no");
    await setEarTipFlag(cat.id, c.id, "no");
    expect((await catRow(cat.id)).status).toBe("spotted");
    const reviews = await openReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].subject).toContain(cat.id);
    expect(await wakeKinds()).toEqual([]);
  });

  it("a caretaker's decision overrides a disagreement and ends the review", async () => {
    const cat = await makeCat();
    const [a, b] = [await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, b.id, "no");
    const care = await makeCaretaker();
    const out = await runAction("cat_set_ear_tip", care.id, { catId: cat.id, earTip: "absent" });
    expect(out.ok).toBe(true);
    expect((await catRow(cat.id)).status).toBe("queued");
    expect(await openReviews()).toHaveLength(0);
    // The same for a tipped cat.
    const other = await makeCat();
    await setEarTipFlag(other.id, a.id, "yes");
    await setEarTipFlag(other.id, b.id, "no");
    expect((await runAction("cat_set_ear_tip", care.id, { catId: other.id, earTip: "present" })).ok).toBe(true);
    const row = await catRow(other.id);
    expect(row.status).toBe("neutered");
    expect(row.earTipped).toBe(true);
    expect(await openReviews()).toHaveLength(0);
  });

  it("a Yes after the cat is queued files a review and does not move it", async () => {
    const cat = await makeCat();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "no");
    await setEarTipFlag(cat.id, b.id, "no");
    expect(await openReviews()).toHaveLength(0);
    await setEarTipFlag(cat.id, c.id, "yes");
    const row = await catRow(cat.id);
    expect(row.status).toBe("queued");
    expect(row.earTipped).toBe(false);
    expect(await openReviews()).toHaveLength(1);
  });

  it("a Yes on a funded cat files a review and changes nothing else", async () => {
    const cat = await makeCat({ status: "funded", earTipped: false });
    const a = await makeUser();
    await setEarTipFlag(cat.id, a.id, "yes");
    expect((await catRow(cat.id)).status).toBe("funded");
    expect(await openReviews()).toHaveLength(1);
  });

  it("flags on a cat that is already neutered do nothing", async () => {
    const cat = await makeCat({ status: "neutered", earTipped: true });
    const a = await makeUser();
    await setEarTipFlag(cat.id, a.id, "yes");
    await setEarTipFlag(cat.id, a.id, "no");
    expect(await openReviews()).toHaveLength(0);
    expect((await catRow(cat.id)).status).toBe("neutered");
  });

  it("the agent cannot fund a cat before the flags have queued it", async () => {
    const cat = await makeCat();
    // Money in the pool, so the only thing in the way is the cat's step.
    await db.insert(donations).values({ gross: 150000, net: 150000, paypalOrderId: "o-pool", status: "captured" });
    await setEarTipFlag(cat.id, (await makeUser()).id, "no");
    const { tools } = createAgentTools({ gateway: new FakeGateway() });
    const tool = tools.find((t) => t.name === "fund_next_cat")!;
    const run = async () => {
      try {
        return JSON.parse((await tool.run(tool.parse({ cat_id: cat.id, reason: "Fund this cat now." }))) as string);
      } catch (e) {
        if (e instanceof ToolError) return JSON.parse(e.content as string);
        throw e;
      }
    };
    expect((await run()).code).toBe("CAT_NOT_QUEUED");
    await setEarTipFlag(cat.id, (await makeUser()).id, "no");
    expect((await catRow(cat.id)).status).toBe("queued");
    expect((await run()).code).toBeUndefined();
    expect((await catRow(cat.id)).status).toBe("funded");
  });
});

describe("POST /api/cats/[id]/ear-tip", () => {
  const post = (id: string, body: unknown) =>
    flagPost(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });
  async function signIn(u: { id: string; username: string; role: string }) {
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: u.role as "donor", username: u.username }));
  }

  it("needs a signed-in person", async () => {
    const cat = await makeCat();
    expect((await post(cat.id, { answer: "no" })).status).toBe(401);
  });

  it("records the answer, answers with only that person's own answer, and takes Not sure back", async () => {
    const cat = await makeCat();
    const a = await makeUser();
    await signIn(a);
    const res = await post(cat.id, { answer: "yes" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: "yes" });
    expect((await post(cat.id, { answer: "unsure" })).status).toBe(200);
    expect(await db.select().from(earTipFlags)).toHaveLength(0);
  });

  it("refuses a bad answer, a bad id and a missing cat", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    expect((await post(cat.id, { answer: "maybe" })).status).toBe(400);
    expect((await post("not-a-uuid", { answer: "no" })).status).toBe(404);
    expect((await post("00000000-0000-4000-8000-000000000000", { answer: "no" })).status).toBe(404);
  });
});

describe("missions and thanks from ear-tip answers", () => {
  it("asks about a spotted cat, but not the person who already answered", async () => {
    const cat = await makeCat({ name: "Kuting" });
    const [a, b] = [await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "no");
    const forA = (await getMissions(new Date(), a.id)).filter((m) => m.kind === "ear");
    const forB = (await getMissions(new Date(), b.id)).filter((m) => m.kind === "ear");
    const anon = (await getMissions(new Date(), null)).filter((m) => m.kind === "ear");
    expect(forA).toEqual([]);
    expect(forB).toMatchObject([{ title: "Confirm Kuting's ear-tip", action: "card", catId: cat.id }]);
    expect(anon).toHaveLength(1);
    // Two matching answers settle it, so nobody is asked.
    await setEarTipFlag(cat.id, b.id, "no");
    expect((await getMissions(new Date(), null)).filter((m) => m.kind === "ear")).toEqual([]);
  });

  it("never carries who answered or how many into a mission", async () => {
    const cat = await makeCat();
    await setEarTipFlag(cat.id, (await makeUser()).id, "yes");
    const text = JSON.stringify(await getMissions(new Date(), null));
    expect(text).not.toMatch(/neighbour_|earTipYes|earTipNo|answeredByMe|userId/);
  });

  it("thanks only an answer that agrees with how the cat settled", async () => {
    const cat = await makeCat();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    await setEarTipFlag(cat.id, a.id, "yes");
    // Not settled yet, so nobody is thanked for it.
    expect((await getCatThanks(cat.id)).map((t) => t.text)).not.toContain("confirmed the ear-tip");
    await setEarTipFlag(cat.id, b.id, "yes");
    const thanks = await getCatThanks(cat.id);
    expect(thanks.filter((t) => t.text === "confirmed the ear-tip")).toHaveLength(2);
    // A person who said No on a cat that turned out tipped earns nothing.
    await setEarTipFlag(cat.id, c.id, "no");
    expect((await getCatThanks(cat.id)).filter((t) => t.text.includes("ear-tip"))).toHaveLength(2);
    expect(JSON.stringify(thanks)).not.toMatch(/verified/i);
  });
});
