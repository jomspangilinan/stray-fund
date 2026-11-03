import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, users } from "../src/server/db/schema";
import { runAction } from "../src/server/caretaker";
import { getCatCard, getYard, listAgentActions } from "../src/server/public";
import { PRIVATE_ACTIONS, SEX_ANSWERED } from "../src/server/privateActions";
import { truncateAll } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { SESSION_COOKIE, signSession } from "../src/server/session";
import { POST as sexPost } from "../src/app/api/cats/[id]/sex/route";

let seq = 0;
async function makeUser(role = "donor") {
  const [u] = await db.insert(users).values({ username: `sexer_${Date.now()}_${++seq}`, role }).returning();
  return u;
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db
    .insert(cats)
    .values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "spotted", ...over })
    .returning();
  return c;
}
const sexOf = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0].sex;
const answered = async () => (await db.select().from(agentActions)).filter((a) => a.action === SEX_ANSWERED);
const post = (id: string, body: unknown, type = "application/json") =>
  sexPost(new Request("http://x/api", { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
async function signIn(u: { id: string; username: string; role: string }) {
  jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: u.role as "donor", username: u.username }));
}

beforeEach(async () => {
  await truncateAll();
  jar.clear();
});
afterAll(closePool);

describe("POST /api/cats/[id]/sex", () => {
  it("needs a signed-in person", async () => {
    const cat = await makeCat();
    expect((await post(cat.id, { answer: "female" })).status).toBe(401);
    expect(await sexOf(cat.id)).toBe("unknown");
  });

  it("sets the sex while it is unknown, and answers with the sex only", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    const res = await post(cat.id, { answer: "female" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sex: "female" });
    expect(await sexOf(cat.id)).toBe("female");
  });

  it("refuses a bad answer, a wrong content type, a bad id and a missing cat", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    for (const answer of ["unknown", "cat", "", 3, null]) expect((await post(cat.id, { answer })).status, String(answer)).toBe(400);
    expect((await post(cat.id, "answer=female", "text/plain")).status).toBe(415);
    expect((await post("not-a-uuid", { answer: "male" })).status).toBe(404);
    expect((await post("00000000-0000-4000-8000-000000000000", { answer: "male" })).status).toBe(404);
    expect(await sexOf(cat.id)).toBe("unknown");
  });

  it("marks the answer unconfirmed, and a caretaker saving the card confirms it, even with the same sex", async () => {
    const cat = await makeCat();
    const care = await makeUser("caretaker");
    await signIn(await makeUser());
    await post(cat.id, { answer: "female" });
    const flag = async () => (await db.select().from(cats).where(eq(cats.id, cat.id)))[0].sexUnconfirmed;
    expect(await flag()).toBe(true);
    expect((await runAction("cat_set_details", care.id, { catId: cat.id, sex: "female", flags: [] })).ok).toBe(true);
    expect(await flag()).toBe(false);
    expect(await sexOf(cat.id)).toBe("female");
  });

  it("still shows the answer on the card and gives the ribbon while unconfirmed", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    await post(cat.id, { answer: "female" });
    expect((await getCatCard(cat.id))!.cat.sex).toBe("Female");
    expect((await getYard(null)).cats.find((c) => c.id === cat.id)!.female).toBe(true);
  });

  it("does not overwrite: a later different answer leaves the first, and says what the sex is", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    await post(cat.id, { answer: "female" });
    await signIn(await makeUser());
    const res = await post(cat.id, { answer: "male" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sex: "female" });
    expect(await sexOf(cat.id)).toBe("female");
    expect(await answered()).toHaveLength(1);
  });

  it("returns early on an unchanged answer: no second audit row", async () => {
    const cat = await makeCat();
    await signIn(await makeUser());
    await post(cat.id, { answer: "male" });
    await post(cat.id, { answer: "male" });
    expect(await answered()).toHaveLength(1);
  });

  it("a caretaker's record wins, before and after", async () => {
    const cat = await makeCat();
    const care = await makeUser("caretaker");
    await signIn(await makeUser());
    await post(cat.id, { answer: "female" });
    expect((await runAction("cat_set_details", care.id, { catId: cat.id, sex: "male", flags: [] })).ok).toBe(true);
    expect(await sexOf(cat.id)).toBe("male");
    await post(cat.id, { answer: "female" });
    expect(await sexOf(cat.id)).toBe("male");
  });

  it("is rate limited: the eleventh answer in a minute gets 429", async () => {
    await signIn(await makeUser());
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post((await makeCat()).id, { answer: "female" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("leaves a private audit row that the public feed never shows, and no one is named on a card or the yard", async () => {
    const cat = await makeCat();
    const u = await makeUser();
    await signIn(u);
    await post(cat.id, { answer: "female" });
    const [row] = await answered();
    expect(row.inputs).toMatchObject({ catId: cat.id, userId: u.id, to: "female" });
    expect(PRIVATE_ACTIONS).toContain(SEX_ANSWERED);
    expect(await listAgentActions()).toEqual([]);
    const text = JSON.stringify([await getCatCard(cat.id), await getYard(u.id)]);
    expect(text).not.toContain(u.id);
    expect(text).not.toContain(u.username);
  });
});
