import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, nameSuggestions, sightings, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { setAiForTests, type AiTransport } from "../src/server/ai/client";
import { runAction } from "../src/server/caretaker";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { CAT_NAMES, parseCatName, pickFreeName } from "../src/lib/catNames";
import { PRIVATE_ACTIONS } from "../src/server/privateActions";
import { processSpot, RateLimited } from "../src/server/spot";
import { buildReveal, loadReveal } from "../src/server/spotReveal";
import { getCatForViewer, getCatCard, getHelped, getHomeData, getMissions, getYard, listAgentActions, listCats } from "../src/server/public";
import { getCatThanks, getHomeThanks } from "../src/server/thanks";
import { getImpact, getLedger } from "../src/server/impact";
import { getNews } from "../src/server/news";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { SESSION_COOKIE, signSession } from "../src/server/session";
import { POST as anotherPost } from "../src/app/api/cats/[id]/another-name/route";
import { POST as suggestPost } from "../src/app/api/cats/[id]/name/route";
import { POST as caretakerPost } from "../src/app/api/caretaker/[action]/route";

let seq = 0;
async function makeUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ username: `person_${Date.now()}_${++seq}`, role: "donor", ...over }).returning();
  return u;
}
const makeCaretaker = () => makeUser({ role: "caretaker", username: `care_${Date.now()}_${++seq}` });
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name: `Cat${++seq}`, areaName: "Brgy 1", ...over }).returning();
  return c;
}
/** A cat whose card was started by this person's sighting. */
async function catFoundBy(finder: { id: string }, over: Partial<typeof cats.$inferInsert> = {}) {
  const cat = await makeCat(over);
  await db.insert(sightings).values({ catId: cat.id, originalKey: `k${++seq}`, caughtByUserId: finder.id, state: "new_cat" });
  return cat;
}
const catRow = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0];
const suggestionsOf = (catId: string) => db.select().from(nameSuggestions).where(eq(nameSuggestions.catId, catId));
const actionsNamed = async (name: string) => (await db.select().from(agentActions)).filter((a) => a.action === name);
const act = (care: { id: string }, name: Parameters<typeof runAction>[0], body: Record<string, unknown>) => runAction(name, care.id, body);

async function signIn(u: { id: string; username: string }, role: "donor" | "caretaker" = "donor") {
  jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role, username: u.username }));
}
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await truncateAll();
  jar.clear();
});
afterEach(() => setAiForTests(null));
afterAll(closePool);

describe("the cat name rules", () => {
  it("accepts letters from any language, spaces, hyphens and apostrophes, trimmed", () => {
    for (const ok of ["Muning", "  Mingming  ", "Anne-Marie", "D'Artagnan", "O’Neil", "José", "Nguyễn", "さくら", "Ángel Luis", "Ada Lovelace", "ñ"]) {
      expect(parseCatName(ok).ok, ok).toBe(true);
    }
    expect(parseCatName("  Mingming  ")).toEqual({ ok: true, name: "Mingming" });
  });

  it("refuses empty, too long, digits, symbols, emoji and control characters", () => {
    for (const bad of ["", "   ", "A".repeat(31), "Muning2", "Mu_ning", "Muning!", "Mu😺ning", "Mu\tning", "Mu\nning", "<b>x</b>", "---", "'", "a.b", 42, null, undefined]) {
      expect(parseCatName(bad).ok, String(bad)).toBe(false);
    }
    expect(parseCatName("A".repeat(30)).ok).toBe(true);
  });

  it("every built-in name passes the rules and none repeat", () => {
    expect(CAT_NAMES.length).toBeGreaterThanOrEqual(40);
    for (const n of CAT_NAMES) expect(parseCatName(n), n).toEqual({ ok: true, name: n });
    expect(new Set(CAT_NAMES.map((n) => n.toLowerCase())).size).toBe(CAT_NAMES.length);
  });

  it("picks a free name from the list, ignoring case, and falls back to a number only when the list is used up", () => {
    const taken = new Set(CAT_NAMES.slice(1).map((n) => n.toLowerCase()));
    expect(pickFreeName(taken)).toBe(CAT_NAMES[0]);
    taken.add(CAT_NAMES[0].toLowerCase());
    const out = pickFreeName(taken);
    expect(out).toMatch(/^\S+ 2$/);
    expect(CAT_NAMES).toContain(out.replace(/ 2$/, ""));
    expect(taken.has(out.toLowerCase())).toBe(false);
  });
});

describe("first names", () => {
  const ASSESS = {
    is_cat: true,
    cat_visible_quality: "good",
    reject_reason: "none",
    coat_pattern: "tabby",
    colors: ["orange"],
    markings: "white socks",
    flags: { kitten: false, pregnant: false, injured: false, sick: false },
    probably_female_by_coat: false,
    suggested_name: "Muning",
    short_bio: "A calm orange cat.",
    no_sensitive_content: true,
    sensitive_regions: [] as unknown[],
  };
  const calls: Parameters<AiTransport>[0][] = [];
  function installAi(name: () => string) {
    calls.length = 0;
    setAiForTests(async (params) => {
      calls.push(params);
      const isMatch = String(params.system).includes("same cat");
      const v = isMatch ? { match_cat_id: null, confidence: 0, reason: "none" } : { ...ASSESS, suggested_name: name() };
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(v) }] };
    });
  }
  const jpeg = (shade: number) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: shade, g: 90, b: 50 } } }).jpeg().toBuffer();
  const assessCalls = () => calls.filter((c) => !String(c.system).includes("same cat"));

  it("asks for a name from the cat's look or character, with no example names to copy", async () => {
    installAi(() => "Muning");
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(100), lat: 10.2, lng: 120.6, userId: u.id });
    const system = String(assessCalls()[0].system);
    const line = system.split("\n").find((l) => l.startsWith("- suggested_name:")) ?? "";
    expect(line).toMatch(/look|personality/i);
    for (const example of ["Muning", "Mingming", "Tigre", "Bituin"]) expect(system).not.toContain(example);
  });

  it("tells the AI which names are taken", async () => {
    installAi(() => "Kiko");
    await makeCat({ name: "Taken One" });
    await makeCat({ name: "Taken Two" });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(110), lat: 10.2, lng: 120.6, userId: u.id });
    const sent = JSON.stringify(assessCalls()[0].messages);
    expect(sent).toContain("Taken One");
    expect(sent).toContain("Taken Two");
  });

  it("gives a taken AI name a free name from the built-in list, not a number", async () => {
    installAi(() => "Muning");
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(100), lat: 10.2, lng: 120.6, userId: u.id });
    await processSpot({ jpeg: await jpeg(130), lat: 10.2, lng: 120.6, userId: u.id });
    const names = (await db.select().from(cats)).map((c) => c.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("Muning");
    const other = names.find((n) => n !== "Muning")!;
    expect(CAT_NAMES).toContain(other);
    expect(other).not.toMatch(/\d/);
  });

  it("treats a taken name case-insensitively", async () => {
    installAi(() => "muning");
    await makeCat({ name: "MUNING" });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(100), lat: 10.2, lng: 120.6, userId: u.id });
    const names = (await db.select().from(cats)).map((c) => c.name);
    expect(names.filter((n) => n.toLowerCase() === "muning")).toHaveLength(1);
  });

  it("uses a number only as a last resort, when every built-in name is taken", async () => {
    await db.insert(cats).values(CAT_NAMES.map((name) => ({ name, areaName: "Brgy 1" })));
    installAi(() => CAT_NAMES[0]);
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(100), lat: 10.2, lng: 120.6, userId: u.id });
    const all = (await db.select().from(cats)).map((c) => c.name);
    const added = all.filter((n) => !CAT_NAMES.includes(n));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/ \d+$/);
    expect(new Set(all.map((n) => n.toLowerCase())).size).toBe(all.length);
  });
});

describe("Another name", () => {
  it("lets the finder take a free name from the list at once, without any AI call", async () => {
    const calls: unknown[] = [];
    setAiForTests(async (p) => {
      calls.push(p);
      throw new Error("no AI call expected");
    });
    const finder = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning" });
    await db.insert(cats).values(CAT_NAMES.slice(0, 5).map((name) => ({ name, areaName: "Brgy 1" })));
    const { anotherName } = await import("../src/server/catNames");
    const name = await anotherName(finder.id, cat.id);
    expect(CAT_NAMES).toContain(name);
    expect(CAT_NAMES.slice(0, 5)).not.toContain(name);
    expect((await catRow(cat.id)).name).toBe(name);
    expect((await catRow(cat.id)).name).not.toBe("Muning");
    expect(calls).toHaveLength(0);
  });

  it("never lands on a name another cat holds, tap after tap", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder);
    const holder = await makeCat({ name: CAT_NAMES[0] });
    const { anotherName } = await import("../src/server/catNames");
    for (let i = 0; i < 6; i++) {
      const before = (await catRow(cat.id)).name;
      const n = await anotherName(finder.id, cat.id);
      expect(n.toLowerCase()).not.toBe(holder.name.toLowerCase());
      expect(n.toLowerCase()).not.toBe(before.toLowerCase());
      expect((await catRow(cat.id)).name).toBe(n);
    }
    expect((await catRow(holder.id)).name).toBe(CAT_NAMES[0]);
  });

  it("refuses someone who is not the finder with 403, and changes nothing", async () => {
    const finder = await makeUser();
    const other = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning" });
    await signIn(other);
    const res = await anotherPost(new Request("http://x/api", json({})), ctx(cat.id));
    expect(res.status).toBe(403);
    expect((await catRow(cat.id)).name).toBe("Muning");
    expect(await actionsNamed("name_another")).toHaveLength(0);
  });

  it("refuses a cat whose card nobody started with a sighting (a seeded cat), with 403", async () => {
    const someone = await makeUser();
    const cat = await makeCat({ name: "Muning" });
    await signIn(someone);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status).toBe(403);
  });

  it("is for the sighting that created the cat, not a later one matched to it", async () => {
    const finder = await makeUser();
    const later = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning" });
    await db.insert(sightings).values({ catId: cat.id, originalKey: "later", caughtByUserId: later.id, state: "matched" });
    await signIn(later);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status).toBe(403);
    await signIn(finder);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status).toBe(200);
  });

  it("needs a signed-in person, a JSON request and a real cat", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status).toBe(401);
    await signIn(finder);
    expect((await anotherPost(new Request("http://x/api", { method: "POST", body: "{}" }), ctx(cat.id))).status).toBe(415);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx("not-a-uuid"))).status).toBe(404);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("stops once a caretaker has approved a name, enforced on the server", async () => {
    const finder = await makeUser();
    const neighbour = await makeUser();
    const care = await makeCaretaker();
    const cat = await catFoundBy(finder);
    await signIn(neighbour);
    await suggestPost(new Request("http://x/api", json({ name: "Kuya Bong" })), ctx(cat.id));
    const [s] = await suggestionsOf(cat.id);
    expect((await act(care, "name_approve", { suggestionId: s.id })).ok).toBe(true);
    await signIn(finder);
    const res = await anotherPost(new Request("http://x/api", json({})), ctx(cat.id));
    expect(res.status).toBe(409);
    expect((await catRow(cat.id)).name).toBe("Kuya Bong");
  });

  it("is only for a cat that is still spotted or queued: later statuses get 409 and no button", async () => {
    const { anotherName, canAskForAnotherName } = await import("../src/server/catNames");
    const finder = await makeUser();
    for (const status of ["funded", "booked", "in_care", "neutered", "adoptable", "adopted"]) {
      const cat = await catFoundBy(finder, { name: `Held ${status}`, status });
      await signIn(finder);
      expect((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status, status).toBe(409);
      expect((await catRow(cat.id)).name).toBe(`Held ${status}`);
      expect(await canAskForAnotherName(db, { id: cat.id, status, nameLocked: false }, finder.id), status).toBe(false);
    }
    for (const status of ["spotted", "queued"]) {
      const cat = await catFoundBy(finder, { status });
      expect(await canAskForAnotherName(db, { id: cat.id, status, nameLocked: false }, finder.id), status).toBe(true);
      expect(typeof (await anotherName(finder.id, cat.id))).toBe("string");
    }
  });

  it("stops once a caretaker has typed a name", async () => {
    const finder = await makeUser();
    const care = await makeCaretaker();
    const cat = await catFoundBy(finder);
    expect((await act(care, "cat_rename", { catId: cat.id, name: "Boss" })).ok).toBe(true);
    await signIn(finder);
    expect((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status).toBe(409);
    expect((await catRow(cat.id)).name).toBe("Boss");
  });

  it("is rate limited: the eleventh tap in a minute gets 429", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder);
    await signIn(finder);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await anotherPost(new Request("http://x/api", json({})), ctx(cat.id))).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    const { anotherName } = await import("../src/server/catNames");
    await expect(anotherName(finder.id, cat.id)).rejects.toBeInstanceOf(RateLimited);
  });

  it("two taps at once end on a free name, never two cats with one name", async () => {
    const finder = await makeUser();
    const a = await catFoundBy(finder);
    const b = await catFoundBy(finder);
    const { anotherName } = await import("../src/server/catNames");
    await Promise.all([anotherName(finder.id, a.id), anotherName(finder.id, b.id)]);
    const names = (await db.select().from(cats)).map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(2);
  });
});

describe("Suggest the real name", () => {
  const post = (id: string, body: unknown) => suggestPost(new Request("http://x/api", json(body)), ctx(id));

  it("keeps a pending request and leaves the public name alone", async () => {
    const finder = await makeUser();
    const neighbour = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning" });
    await signIn(neighbour);
    const res = await post(cat.id, { name: "  Kuya Bong " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: "Kuya Bong" });
    const [row] = await suggestionsOf(cat.id);
    expect(row).toMatchObject({ requesterId: neighbour.id, name: "Kuya Bong", status: "pending", decidedBy: null, decidedAt: null });
    expect((await catRow(cat.id)).name).toBe("Muning");
  });

  it("lets any signed-in role suggest, and refuses a stranger with 401", async () => {
    const cat = await makeCat();
    expect((await post(cat.id, { name: "Ana" })).status).toBe(401);
    for (const role of ["donor", "vet", "foster", "caretaker"] as const) {
      const u = await makeUser({ role });
      await signIn(u, role === "caretaker" ? "caretaker" : "donor");
      expect((await post(cat.id, { name: "Ana" })).status).toBe(200);
    }
  });

  it("refuses names outside the rules with 400 and stores nothing", async () => {
    const u = await makeUser();
    const cat = await makeCat();
    await signIn(u);
    for (const name of ["", "   ", "A".repeat(31), "Muning2", "Mu😺", "x_y", "<b>", undefined, 5, null, ["a"]]) {
      expect((await post(cat.id, { name })).status, JSON.stringify(name)).toBe(400);
    }
    expect((await post(cat.id, {})).status).toBe(400);
    expect(await suggestionsOf(cat.id)).toHaveLength(0);
  });

  it("refuses a missing cat with 404, a bad id with 404, and a non-JSON request with 415", async () => {
    const u = await makeUser();
    await signIn(u);
    expect((await post("00000000-0000-4000-8000-000000000000", { name: "Ana" })).status).toBe(404);
    expect((await post("nope", { name: "Ana" })).status).toBe(404);
    const cat = await makeCat();
    expect((await suggestPost(new Request("http://x/api", { method: "POST", body: "name=Ana" }), ctx(cat.id))).status).toBe(415);
  });

  it("replaces that person's earlier pending request: one pending per person per cat", async () => {
    const u = await makeUser();
    const v = await makeUser();
    const cat = await makeCat();
    await signIn(u);
    await post(cat.id, { name: "First" });
    await post(cat.id, { name: "Second" });
    await signIn(v);
    await post(cat.id, { name: "Other" });
    const rows = await suggestionsOf(cat.id);
    expect(rows.filter((r) => r.status === "pending").map((r) => r.name).sort()).toEqual(["Other", "Second"]);
    expect(rows).toHaveLength(2);
  });

  it("two requests at once from one person leave one pending row", async () => {
    const u = await makeUser();
    const cat = await makeCat();
    await signIn(u);
    await Promise.all([post(cat.id, { name: "One" }), post(cat.id, { name: "Two" })]);
    expect((await suggestionsOf(cat.id)).filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("a person whose suggestion was decided can send a new one", async () => {
    const u = await makeUser();
    const care = await makeCaretaker();
    const cat = await makeCat();
    await signIn(u);
    await post(cat.id, { name: "First" });
    const [s] = await suggestionsOf(cat.id);
    await act(care, "name_dismiss", { suggestionId: s.id });
    expect((await post(cat.id, { name: "Again" })).status).toBe(200);
    const rows = await suggestionsOf(cat.id);
    expect(rows.map((r) => [r.name, r.status]).sort()).toEqual([["Again", "pending"], ["First", "dismissed"]]);
  });

  it("is rate limited: the eleventh request in a minute gets 429", async () => {
    const u = await makeUser();
    const cat = await makeCat();
    await signIn(u);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(cat.id, { name: `Name${"abcdefghijklmnop"[i]}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("shows the person only their own pending request", async () => {
    const { nameControls } = await import("../src/server/catNames");
    const u = await makeUser();
    const v = await makeUser();
    const cat = await makeCat();
    await signIn(u);
    await post(cat.id, { name: "Mine" });
    expect(await nameControls(cat.id, u.id)).toEqual({ canRename: false, pending: "Mine" });
    expect(await nameControls(cat.id, v.id)).toEqual({ canRename: false, pending: null });
  });
});

describe("the caretaker desk", () => {
  async function pending(cat: { id: string }, name: string, over: Partial<typeof users.$inferInsert> = {}) {
    const u = await makeUser(over);
    await signIn(u);
    await suggestPost(new Request("http://x/api", json({ name })), ctx(cat.id));
    return u;
  }
  const first = async (catId: string, name: string) => (await suggestionsOf(catId)).find((s) => s.name === name)!;

  it("lists pending suggestions with the cat's photo, current name and the suggested name", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning" });
    const [s] = await db.select().from(sightings).where(eq(sightings.catId, cat.id));
    await pending(cat, "Kuya Bong");
    const q = await getCaretakerQueue();
    expect(q.nameSuggestions).toHaveLength(1);
    expect(q.nameSuggestions[0]).toMatchObject({ catId: cat.id, catName: "Muning", name: "Kuya Bong", photoSightingId: s.id });
    expect(JSON.stringify(q.nameSuggestions)).not.toMatch(/person_/);
  });

  it("approve sets the name, locks it, marks it approved, dismisses the other pending ones, and audits", async () => {
    const cat = await makeCat({ name: "Muning" });
    const care = await makeCaretaker();
    await pending(cat, "Kuya Bong");
    await pending(cat, "Boss");
    const bong = await first(cat.id, "Kuya Bong");
    const out = await act(care, "name_approve", { suggestionId: bong.id });
    expect(out).toMatchObject({ ok: true, status: 200 });
    expect(await catRow(cat.id)).toMatchObject({ name: "Kuya Bong", nameLocked: true });
    const rows = await suggestionsOf(cat.id);
    expect(rows.find((r) => r.name === "Kuya Bong")).toMatchObject({ status: "approved", decidedBy: care.id });
    expect(rows.find((r) => r.name === "Kuya Bong")!.decidedAt).not.toBeNull();
    expect(rows.find((r) => r.name === "Boss")).toMatchObject({ status: "dismissed", decidedBy: care.id });
    const [a] = await actionsNamed("name_approved");
    expect(a.approvedBy).toBe(care.id);
    expect(a.inputs).toMatchObject({ catId: cat.id, suggestionId: bong.id, from: "Muning", to: "Kuya Bong" });
  });

  it("approve handles a taken name like a new cat: a free built-in name, and says so", async () => {
    await makeCat({ name: "Kuya Bong" });
    const cat = await makeCat({ name: "Muning" });
    const care = await makeCaretaker();
    await pending(cat, "kuya bong");
    const s = (await suggestionsOf(cat.id))[0];
    const out = await act(care, "name_approve", { suggestionId: s.id });
    expect(out.ok).toBe(true);
    const now = (await catRow(cat.id)).name;
    expect(CAT_NAMES).toContain(now);
    expect(out.message).toContain(now);
    expect((await suggestionsOf(cat.id))[0].status).toBe("approved");
  });

  it("approve is fine when the suggestion only changes the cat's own spelling", async () => {
    const cat = await makeCat({ name: "muning" });
    const care = await makeCaretaker();
    await pending(cat, "Muning");
    const s = (await suggestionsOf(cat.id))[0];
    expect((await act(care, "name_approve", { suggestionId: s.id })).ok).toBe(true);
    expect((await catRow(cat.id)).name).toBe("Muning");
  });

  it("dismiss marks it dismissed, leaves the name, does not lock, and audits", async () => {
    const cat = await makeCat({ name: "Muning" });
    const care = await makeCaretaker();
    await pending(cat, "Boss");
    const s = (await suggestionsOf(cat.id))[0];
    expect(await act(care, "name_dismiss", { suggestionId: s.id })).toMatchObject({ ok: true, status: 200 });
    expect(await catRow(cat.id)).toMatchObject({ name: "Muning", nameLocked: false });
    expect((await suggestionsOf(cat.id))[0]).toMatchObject({ status: "dismissed", decidedBy: care.id });
    expect((await actionsNamed("name_dismissed"))[0].inputs).toMatchObject({ catId: cat.id, suggestionId: s.id });
  });

  it("answers 409 for a request someone else already decided, and 404 for one that does not exist", async () => {
    const cat = await makeCat({ name: "Muning" });
    const [one, two] = [await makeCaretaker(), await makeCaretaker()];
    await pending(cat, "Boss");
    const s = (await suggestionsOf(cat.id))[0];
    expect((await act(one, "name_dismiss", { suggestionId: s.id })).ok).toBe(true);
    expect(await act(two, "name_approve", { suggestionId: s.id })).toMatchObject({ ok: false, status: 409 });
    expect(await act(two, "name_dismiss", { suggestionId: s.id })).toMatchObject({ ok: false, status: 409 });
    expect((await catRow(cat.id)).name).toBe("Muning");
    expect(await actionsNamed("name_approved")).toHaveLength(0);
    expect(await act(two, "name_approve", { suggestionId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ status: 404 });
    expect(await act(two, "name_approve", { suggestionId: "nope" })).toMatchObject({ status: 400 });
  });

  it("two caretakers approving at once: one 200, one 409, one audit row", async () => {
    const cat = await makeCat({ name: "Muning" });
    const [one, two] = [await makeCaretaker(), await makeCaretaker()];
    await pending(cat, "Boss");
    const s = (await suggestionsOf(cat.id))[0];
    const [a, b] = await Promise.all([act(one, "name_approve", { suggestionId: s.id }), act(two, "name_approve", { suggestionId: s.id })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await actionsNamed("name_approved")).toHaveLength(1);
  });

  it("approving one suggestion for a cat does not touch suggestions for other cats", async () => {
    const [a, b] = [await makeCat({ name: "A" }), await makeCat({ name: "B" })];
    const care = await makeCaretaker();
    await pending(a, "Alpha");
    await pending(b, "Beta");
    await act(care, "name_approve", { suggestionId: (await suggestionsOf(a.id))[0].id });
    expect((await suggestionsOf(b.id))[0].status).toBe("pending");
  });

  it("direct rename sets a caretaker name, locks it, audits, and validates", async () => {
    const cat = await makeCat({ name: "Muning" });
    const care = await makeCaretaker();
    expect(await act(care, "cat_rename", { catId: cat.id, name: "  Boss Ana " })).toMatchObject({ ok: true, status: 200 });
    expect(await catRow(cat.id)).toMatchObject({ name: "Boss Ana", nameLocked: true });
    const [a] = await actionsNamed("name_set");
    expect(a.approvedBy).toBe(care.id);
    expect(a.inputs).toMatchObject({ catId: cat.id, from: "Muning", to: "Boss Ana" });
    expect(await act(care, "cat_rename", { catId: cat.id, name: "Bad1" })).toMatchObject({ ok: false, status: 400 });
    expect(await act(care, "cat_rename", { catId: cat.id, name: "" })).toMatchObject({ ok: false, status: 400 });
    expect(await act(care, "cat_rename", { catId: "00000000-0000-4000-8000-000000000000", name: "Ok" })).toMatchObject({ status: 404 });
    expect((await catRow(cat.id)).name).toBe("Boss Ana");
    expect(await actionsNamed("name_set")).toHaveLength(1);
  });

  it("direct rename onto a name another cat holds gives a free built-in name instead", async () => {
    await makeCat({ name: "Boss" });
    const cat = await makeCat({ name: "Muning" });
    const care = await makeCaretaker();
    const out = await act(care, "cat_rename", { catId: cat.id, name: "BOSS" });
    expect(out.ok).toBe(true);
    expect(CAT_NAMES).toContain((await catRow(cat.id)).name);
  });

  it("only a caretaker session can use the desk routes", async () => {
    const cat = await makeCat();
    const u = await makeUser();
    await signIn(u, "donor");
    const res = await caretakerPost(new Request("http://x/api", json({ catId: cat.id, name: "Boss" })), { params: Promise.resolve({ action: "cat_rename" }) });
    expect(res.status).toBe(403);
    expect((await catRow(cat.id)).name).not.toBe("Boss");
  });
});

describe("privacy of names", () => {
  const SENTINEL_USER = "zq_Sentinel_Namer";
  const UNAPPROVED = "Zxqunapproved";

  async function publicReads(catId: string, viewerId: string | null) {
    return JSON.stringify([
      await listCats("all"),
      await getCatCard(catId),
      await getCatForViewer(catId, null),
      await getHomeData(),
      await getYard(viewerId),
      await getMissions(new Date(), viewerId),
      await listAgentActions(),
      await getCatThanks(catId),
      await getHomeThanks(),
      await getLedger(),
      await getImpact(),
      await getNews(viewerId ?? "00000000-0000-4000-8000-000000000000"),
    ]);
  }

  it("never shows an unapproved name, or who suggested it, in any public read", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning", status: "queued" });
    const namer = await makeUser({ username: SENTINEL_USER, showNameInThanks: true });
    await signIn(namer);
    await suggestPost(new Request("http://x/api", json({ name: UNAPPROVED })), ctx(cat.id));
    const reads = await publicReads(cat.id, namer.id);
    expect(reads).not.toContain(UNAPPROVED);
    expect(reads).not.toContain(SENTINEL_USER);
    expect(reads).not.toContain(namer.id);
    // The finder's reveal is a public-shaped read too.
    const [s] = await db.select().from(sightings).where(eq(sightings.catId, cat.id));
    const reveal = JSON.stringify(await loadReveal(s.id, "new_cat"));
    expect(reveal).not.toContain(UNAPPROVED);
    expect(reveal).not.toContain(SENTINEL_USER);
    expect((await getHelped(namer.id)).length).toBe(0);
  });

  it("an approved name is public, but who suggested it still is not", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning", status: "queued" });
    const namer = await makeUser({ username: SENTINEL_USER, showNameInThanks: true });
    const care = await makeCaretaker();
    await signIn(namer);
    await suggestPost(new Request("http://x/api", json({ name: UNAPPROVED })), ctx(cat.id));
    await act(care, "name_approve", { suggestionId: (await suggestionsOf(cat.id))[0].id });
    const reads = await publicReads(cat.id, namer.id);
    expect(reads).toContain(UNAPPROVED);
    expect(reads).not.toContain(SENTINEL_USER);
    expect(reads).not.toContain(namer.id);
    expect(reads).not.toContain(care.id);
    expect(reads).not.toContain(care.username);
  });

  it("keeps every name action out of the public feed, so the newest money action stays on top", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder);
    await db.insert(agentActions).values({ action: "fund_cat", reason: "Funded a cat.", status: "done", inputs: { catId: cat.id } });
    const namer = await makeUser({ username: SENTINEL_USER });
    const care = await makeCaretaker();
    await signIn(namer);
    await suggestPost(new Request("http://x/api", json({ name: "Ana" })), ctx(cat.id));
    await signIn(finder);
    await anotherPost(new Request("http://x/api", json({})), ctx(cat.id));
    const s = (await suggestionsOf(cat.id))[0];
    await act(care, "name_dismiss", { suggestionId: s.id });
    await signIn(namer);
    await suggestPost(new Request("http://x/api", json({ name: "Ben" })), ctx(cat.id));
    await act(care, "name_approve", { suggestionId: (await suggestionsOf(cat.id)).find((r) => r.status === "pending")!.id });
    await act(care, "cat_rename", { catId: cat.id, name: "Boss" });
    for (const name of ["name_suggested", "name_another", "name_dismissed", "name_approved", "name_set"]) {
      expect((await actionsNamed(name)).length, name).toBeGreaterThan(0);
    }
    const feed = await listAgentActions();
    expect(feed.map((r) => r.action)).toEqual(["Funded a cat"]);
    expect((await listAgentActions(1))[0].action).toBe("Funded a cat");
    expect(JSON.stringify(feed)).not.toContain(SENTINEL_USER);
  });

  it("the private set is one named list that holds the ear-tip answer, the sex answer and every name action", () => {
    expect([...PRIVATE_ACTIONS].sort()).toEqual(
      ["ear_tip_answered", "name_another", "name_approved", "name_dismissed", "name_set", "name_suggested", "sex_answered"].sort(),
    );
  });
});

describe("the finder's reveal", () => {
  const sighting = { publicKey: null, publicReady: false, coatSaysFemale: false };
  const cat = { id: "11111111-1111-4111-8111-111111111111", name: "Pepita", status: "queued", sex: "unknown", coatPattern: "tabby", avatar: null, flags: [] };

  it("carries canRename only when told, and never on a review", () => {
    expect(buildReveal({ state: "new_cat", cat, sighting, canRename: true })?.canRename).toBe(true);
    expect(buildReveal({ state: "new_cat", cat, sighting })?.canRename).toBe(false);
    expect(buildReveal({ state: "needs_review", cat: null, sighting, canRename: true })?.canRename).toBe(false);
  });

  it("offers the rename to the finder of a new cat, and withdraws it once a caretaker named the cat", async () => {
    const finder = await makeUser();
    const cat = await db.insert(cats).values({ name: "Muning", areaName: "Brgy 1" }).returning().then((r) => r[0]);
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: "k", caughtByUserId: finder.id, state: "new_cat" }).returning();
    expect((await loadReveal(s.id, "new_cat"))?.canRename).toBe(true);
    await db.update(cats).set({ nameLocked: true }).where(eq(cats.id, cat.id));
    expect((await loadReveal(s.id, "new_cat"))?.canRename).toBe(false);
  });

  it("does not offer it when the sighting only matched a cat someone else found", async () => {
    const finder = await makeUser();
    const later = await makeUser();
    const cat = await catFoundBy(finder);
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: "k2", caughtByUserId: later.id, state: "matched" }).returning();
    expect((await loadReveal(s.id, "matched"))?.canRename).toBe(false);
  });
});

describe("names in past records", () => {
  it("a stored treasurer reason keeps the old name, while joined reads show the new one", async () => {
    const finder = await makeUser();
    const cat = await catFoundBy(finder, { name: "Muning" });
    await db.insert(agentActions).values({ action: "fund_cat", reason: "Funded Muning first.", status: "done", inputs: { catId: cat.id } });
    const care = await makeCaretaker();
    await act(care, "cat_rename", { catId: cat.id, name: "Boss" });
    const [row] = await listAgentActions();
    expect(row.reason).toBe("Funded Muning first.");
    expect(row.cat).toBe("Boss");
  });
});
