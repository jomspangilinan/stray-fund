import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { closePool, db } from "../src/server/db/client";
import { cats, sightings, users, wakeups } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { createTestPool } from "./helpers/db";
import { COLONY } from "../src/lib/config";
import { setAiForTests, type AiTransport } from "../src/server/ai/client";
import { storeOriginal, InvalidPhoto } from "../src/server/photos";
import { getStorage } from "../src/server/storage";
import { SESSION_COOKIE, signSession } from "../src/server/session";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import {
  applyAssessment,
  finishSighting,
  processSpot,
  RateLimited,
  retryPendingSightings,
} from "../src/server/spot";
import { POST as spotPost } from "../src/app/api/spot/route";

const ASSESS = {
  is_cat: true,
  cat_visible_quality: "good",
  coat_pattern: "tabby",
  colors: ["orange"],
  markings: "white socks",
  ear_tip: "absent",
  ear_tip_confidence: 0.9,
  flags: { kitten: false, pregnant: false, injured: false, sick: false },
  probably_female_by_coat: false,
  suggested_name: "Muning",
  short_bio: "A calm orange cat.",
  sensitive_regions: [] as unknown[],
};
type Json = Record<string, unknown>;
const assessWith = (patch: Json = {}) => ({ ...ASSESS, ...patch });

type Script = { assess: () => Json | Error; match: () => Json | Error };
let script: Script;
const seen = { assess: 0, match: 0, matchParams: [] as Parameters<AiTransport>[0][] };
let inspect: (() => Promise<void>) | null = null;

const noMatch = () => ({ match_cat_id: null, confidence: 0, reason: "none" });

function installAi() {
  setAiForTests(async (params) => {
    if (inspect) await inspect();
    const isMatch = String(params.system).includes("same cat");
    if (isMatch) {
      seen.match++;
      seen.matchParams.push(params);
    } else seen.assess++;
    const v = isMatch ? script.match() : script.assess();
    if (v instanceof Error) throw v;
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(v) }] };
  });
}

async function jpeg(shade = 120): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: shade, g: 90, b: 50 } } })
    .jpeg()
    .toBuffer();
}

let seq = 0;
async function makeUser() {
  const [u] = await db
    .insert(users)
    .values({ username: `finder_${Date.now()}_${++seq}`, role: "donor" })
    .returning();
  return u;
}

const catRows = () => db.select().from(cats);
const sightingRows = () => db.select().from(sightings).orderBy(sightings.createdAt);
const wakeupKinds = async () => (await db.select().from(wakeups)).map((w) => w.kind);

async function seedCat(opts: {
  name?: string;
  coatPattern?: string;
  status?: string;
  earTipped?: boolean | null;
  flags?: string[];
  photos?: number;
}) {
  const [cat] = await db
    .insert(cats)
    .values({
      name: opts.name ?? `Seed${++seq}`,
      coatPattern: opts.coatPattern ?? "tabby",
      status: opts.status ?? "spotted",
      earTipped: opts.earTipped === undefined ? null : opts.earTipped,
      flags: opts.flags ?? [],
      areaName: COLONY.area_name,
      exactLat: 10.2,
      exactLng: 120.6,
      fuzzedLat: 10.203,
      fuzzedLng: 120.603,
    })
    .returning();
  const keys: string[] = [];
  for (let i = 0; i < (opts.photos ?? 1); i++) {
    const { key } = await storeOriginal(await jpeg(100 + i));
    keys.push(key);
    await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "matched" });
    // Distinct, increasing creation times so "newest first" is testable.
    await db.execute(
      (await import("drizzle-orm")).sql`update sightings set created_at = now() - make_interval(secs => ${100 - i}) where original_key = ${key}`,
    );
  }
  return { cat, keys };
}

async function pendingSighting(ageSeconds: number, userId?: string) {
  const { key } = await storeOriginal(await jpeg());
  const uid = userId ?? (await makeUser()).id;
  const [s] = await db
    .insert(sightings)
    .values({ originalKey: key, caughtByUserId: uid, state: "pending" })
    .returning();
  await db.execute(
    (await import("drizzle-orm")).sql`update sightings set created_at = now() - make_interval(secs => ${ageSeconds}) where id = ${s.id}`,
  );
  return s;
}

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  inspect = null;
  seen.assess = 0;
  seen.match = 0;
  seen.matchParams = [];
  script = { assess: () => assessWith(), match: noMatch };
  installAi();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AI_DAILY_CALL_CAP;
});
afterAll(async () => {
  setAiForTests(null);
  await closePool();
});

describe("processSpot: new cats", () => {
  it("creates a queued cat with a generated name, bio and a public photo", async () => {
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    const [cat] = await catRows();
    expect(out.catId).toBe(cat.id);
    expect(cat).toMatchObject({
      name: "Muning",
      bio: "A calm orange cat.",
      coatPattern: "tabby",
      status: "queued",
      earTipped: false,
      sex: "unknown",
      areaName: COLONY.area_name,
      locationApproximate: false,
    });
    expect(cat.queuedAt).not.toBeNull();
    expect(await wakeupKinds()).toEqual(["cat_queued"]);
    const [s] = await sightingRows();
    expect(s).toMatchObject({ state: "new_cat", catId: cat.id, publicReady: true, caughtByUserId: u.id });
    expect(s.publicKey).toMatch(/^photos\//);
    expect(s.assessment).toMatchObject({ suggested_name: "Muning" });
  });

  it("marks an ear-tipped cat neutered with no wakeup", async () => {
    script.assess = () => assessWith({ ear_tip: "present", ear_tip_confidence: 0.95 });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [cat] = await catRows();
    expect(cat).toMatchObject({ status: "neutered", earTipped: true, queuedAt: null });
    expect(await wakeupKinds()).toEqual([]);
  });

  it.each([
    ["unknown", 0.95],
    ["absent", 0.5],
    ["present", 0.79],
  ])("keeps a spotted cat for a %s ear tip at %s confidence and asks for review", async (ear, conf) => {
    script.assess = () => assessWith({ ear_tip: ear, ear_tip_confidence: conf });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
    expect(out.catId).toBeTruthy();
    const [cat] = await catRows();
    expect(cat).toMatchObject({ status: "spotted", earTipped: null, queuedAt: null });
    const [s] = await sightingRows();
    expect(s).toMatchObject({ state: "needs_review", catId: cat.id });
    expect(await wakeupKinds()).toEqual([]);
  });

  it("uses the guardrail ear-tip threshold", async () => {
    await db.execute((await import("drizzle-orm")).sql`update guardrails set ear_tip_confidence_min = 0.5`);
    script.assess = () => assessWith({ ear_tip: "absent", ear_tip_confidence: 0.6 });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    expect((await catRows())[0].status).toBe("queued");
  });

  it("numbers a name that is already taken and falls back for a blank name", async () => {
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    script.assess = () => assessWith({ suggested_name: "   " });
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const names = (await catRows()).map((c) => c.name).sort();
    expect(names).toEqual(["Little stray", "Muning", "Muning 2"]);
  });

  it("takes sex from the form, else female only for a calico or tortoiseshell coat, else unknown", async () => {
    const u = await makeUser();
    const base = { jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id };
    script.assess = () => assessWith({ suggested_name: "A", probably_female_by_coat: true });
    await processSpot(base);
    script.assess = () => assessWith({ suggested_name: "B", probably_female_by_coat: true });
    await processSpot({ ...base, sex: "male" });
    script.assess = () => assessWith({ suggested_name: "C" });
    await processSpot(base);
    const bySex = Object.fromEntries((await catRows()).map((c) => [c.name, c.sex]));
    expect(bySex).toEqual({ A: "female", B: "male", C: "unknown" });
  });

  it("copies flags from the assessment", async () => {
    script.assess = () => assessWith({ flags: { kitten: true, pregnant: false, injured: true, sick: false } });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await catRows())[0].flags.sort()).toEqual(["injured", "kitten"]);
  });
});

describe("processSpot: rejected photos", () => {
  it.each([
    ["a dog", { is_cat: false }],
    ["a poor photo", { cat_visible_quality: "poor" }],
  ])("%s creates no cat and never asks for a match", async (_n, patch) => {
    const u = await makeUser();
    await seedCat({});
    script.assess = () => assessWith(patch);
    const out2 = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out2.state).toBe("rejected");
    expect(out2.catId).toBeUndefined();
    expect(out2.message).toMatch(/try/i);
    const rows = await sightingRows();
    expect(rows.at(-1)).toMatchObject({ state: "rejected", catId: null, publicReady: false, publicKey: null });
    expect(seen.match).toBe(0);
    expect(await catRows()).toHaveLength(1);
  });
});

describe("processSpot: matching", () => {
  it("adds a sighting to the matched cat and creates no new cat", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same face" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out).toMatchObject({ state: "matched", catId: cat.id });
    expect(await catRows()).toHaveLength(1);
    const [s] = await db.select().from(sightings).orderBy(desc(sightings.createdAt));
    expect(s).toMatchObject({ state: "matched", catId: cat.id, matchConfidence: 0.9, publicReady: true });
  });

  it("only offers cats with the same coat pattern, newest six, three photos each, newest first", async () => {
    const tabbies: string[] = [];
    for (let i = 0; i < 7; i++) tabbies.push((await seedCat({ name: `T${i}`, photos: 4 })).cat.id);
    const calico = (await seedCat({ name: "Calico", coatPattern: "calico" })).cat.id;
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(seen.match).toBe(1);
    const content = seen.matchParams[0].messages[0].content as { type: string; text?: string }[];
    const text = content.find((c) => c.type === "text")?.text ?? "";
    expect(content.filter((c) => c.type === "image")).toHaveLength(1 + 6 * 3);
    expect(text).not.toContain(calico);
    expect(text).not.toContain(tabbies[0]);
    for (const id of tabbies.slice(1)) expect(text).toContain(id);
  });

  it("sends the private original, matching what the scrubber later blurs", async () => {
    await seedCat({});
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [s] = await db.select().from(sightings).orderBy(desc(sightings.createdAt));
    const stored = await getStorage().getPrivate(s.originalKey);
    const content = seen.matchParams[0].messages[0].content as { type: string; source?: { data: string } }[];
    const first = content.find((c) => c.type === "image");
    expect(first?.source?.data).toBe(stored.toString("base64"));
  });

  it("sends a mid band match to review without creating a cat", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.6, reason: "maybe" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
    expect(out.catId).toBeUndefined();
    expect(await catRows()).toHaveLength(1);
    const [s] = await db.select().from(sightings).orderBy(desc(sightings.createdAt));
    expect(s).toMatchObject({ state: "needs_review", catId: null });
    expect((s.assessment as { candidate_cat_ids: string[] }).candidate_cat_ids).toEqual([cat.id]);
  });

  it("makes a new cat below the mid band", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.4, reason: "unlikely" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    expect(await catRows()).toHaveLength(2);
  });

  it("uses the guardrail match threshold", async () => {
    await db.execute((await import("drizzle-orm")).sql`update guardrails set match_confidence_min = 0.95`);
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "close" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
  });

  it("never regresses status: a queued cat stays queued on a confident absent tip", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("matched");
    expect((await catRows())[0]).toMatchObject({ status: "queued", earTipped: false });
    expect(await wakeupKinds()).toEqual([]);
  });

  it("sends a newly confident ear tip on a queued cat to review without changing status", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false });
    script.assess = () => assessWith({ ear_tip: "present", ear_tip_confidence: 0.95 });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out).toMatchObject({ state: "needs_review", catId: cat.id });
    expect((await catRows())[0]).toMatchObject({ status: "queued", earTipped: false });
    const [s] = await db.select().from(sightings).orderBy(desc(sightings.createdAt));
    expect(s).toMatchObject({ state: "needs_review", catId: cat.id });
  });

  it("leaves a neutered cat alone when a later photo says absent", async () => {
    const { cat } = await seedCat({ status: "neutered", earTipped: true });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("matched");
    expect((await catRows())[0]).toMatchObject({ status: "neutered", earTipped: true });
  });

  it("resolves a spotted cat with unknown ear tip through the transition and queues it", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [row] = await catRows();
    expect(row).toMatchObject({ status: "queued", earTipped: false });
    expect(row.queuedAt).not.toBeNull();
    expect(await wakeupKinds()).toEqual(["cat_queued"]);
  });

  it("keeps a spotted cat spotted when the new photo is not confident", async () => {
    const { cat } = await seedCat({});
    script.assess = () => assessWith({ ear_tip: "unknown", ear_tip_confidence: 0.2 });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("matched");
    expect((await catRows())[0]).toMatchObject({ status: "spotted", earTipped: null });
  });

  it("merges flags and never removes them", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false, flags: ["injured"] });
    script.assess = () => assessWith({ flags: { kitten: false, pregnant: true, injured: false, sick: false } });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await catRows())[0].flags.sort()).toEqual(["injured", "pregnant"]);
  });

  it("sends to review, not new cat, when the match call is refused", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "x" });
    setAiForTests(async (params) => {
      if (String(params.system).includes("same cat")) return { stop_reason: "refusal", content: [] };
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(assessWith()) }] };
    });
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
    expect(await catRows()).toHaveLength(1);
    const [s] = await db.select().from(sightings).orderBy(desc(sightings.createdAt));
    expect((s.assessment as { candidate_cat_ids: string[] }).candidate_cat_ids).toEqual([cat.id]);
  });
});

describe("location", () => {
  it("fixes the fuzz at creation; a later sighting changes nothing", async () => {
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [before] = await catRows();
    expect(before.exactLat).toBe(10.2);
    expect(before.exactLng).toBe(120.6);
    const dLat = (before.fuzzedLat! - 10.2) * 111_320;
    const dLng = (before.fuzzedLng! - 120.6) * 111_320 * Math.cos((10.2 * Math.PI) / 180);
    const metres = Math.hypot(dLat, dLng);
    expect(metres).toBeGreaterThan(250);
    expect(metres).toBeLessThan(750);

    script.match = () => ({ match_cat_id: before.id, confidence: 0.9, reason: "same" });
    await processSpot({ jpeg: await jpeg(), lat: 10.3, lng: 120.7, userId: u.id });
    const [after] = await catRows();
    expect(after).toMatchObject({
      exactLat: before.exactLat,
      exactLng: before.exactLng,
      fuzzedLat: before.fuzzedLat,
      fuzzedLng: before.fuzzedLng,
    });
  });

  it("uses the colony centre, marked approximate, when there is no location", async () => {
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: null, lng: null, userId: u.id });
    const [cat] = await catRows();
    expect(cat.locationApproximate).toBe(true);
    expect(cat.exactLat).toBe(COLONY.centre.lat);
    expect(cat.exactLng).toBe(COLONY.centre.lng);
    expect(cat.fuzzedLat).not.toBe(COLONY.centre.lat);
  });
});

describe("public photo", () => {
  it("blurs the assessment's sensitive regions and makes the photo public", async () => {
    script.assess = () => assessWith({ sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] });
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [s] = await sightingRows();
    expect(s.publicReady).toBe(true);
    const memory = getStorage() as unknown as { readPublic(k: string): Buffer };
    expect(memory.readPublic(s.publicKey!).length).toBeGreaterThan(0);
  });

  it("keeps public_ready false and still creates the cat when publishing fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getStorage(), "putPublic").mockRejectedValue(new Error("disk full"));
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    const [s] = await sightingRows();
    expect(s).toMatchObject({ publicReady: false, publicKey: null, state: "new_cat" });
    expect(err).toHaveBeenCalled();
  });
});

describe("processSpot: input and AI outage", () => {
  it("rejects a file that is not an image and writes nothing", async () => {
    const u = await makeUser();
    await expect(
      processSpot({ jpeg: Buffer.from("not a photo"), lat: null, lng: null, userId: u.id }),
    ).rejects.toBeInstanceOf(InvalidPhoto);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("keeps the sighting pending when AI is unavailable, then retry completes it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    script.assess = () => new Error("down");
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("queued_for_ai");
    expect(out.message).toMatch(/Saved/);
    expect(await catRows()).toHaveLength(0);
    const [s] = await sightingRows();
    expect(s).toMatchObject({ state: "pending", catId: null, publicReady: false });

    script.assess = () => assessWith();
    // Too fresh to retry.
    expect(await retryPendingSightings()).toMatchObject({ examined: 0 });
    await db.execute((await import("drizzle-orm")).sql`update sightings set created_at = now() - interval '2 minutes'`);
    const res = await retryPendingSightings();
    expect(res).toMatchObject({ examined: 1, completed: 1 });
    const [cat] = await catRows();
    expect(cat.exactLat).toBe(10.2);
    expect(cat.exactLng).toBe(120.6);
    expect((await sightingRows())[0]).toMatchObject({ state: "new_cat", catId: cat.id, publicReady: true });
  });

  it("queues for AI when the daily budget is spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.AI_DAILY_CALL_CAP = "0";
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: null, lng: null, userId: u.id });
    expect(out.state).toBe("queued_for_ai");
    expect(seen.assess).toBe(0);
  });

  it("remembers the sex asked for through a retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    script.assess = () => new Error("down");
    const u = await makeUser();
    await processSpot({ jpeg: await jpeg(), lat: null, lng: null, userId: u.id, sex: "male" });
    script.assess = () => assessWith();
    await db.execute((await import("drizzle-orm")).sql`update sightings set created_at = now() - interval '2 minutes'`);
    await retryPendingSightings();
    expect((await catRows())[0]).toMatchObject({ sex: "male", locationApproximate: true });
  });
});

describe("one-time apply", () => {
  it("applyAssessment is idempotent per sighting", async () => {
    const s = await pendingSighting(5);
    const a = assessWith() as never;
    const first = await applyAssessment(s.id, a, { catId: null, confidence: 0, candidateIds: [] });
    const second = await applyAssessment(s.id, a, { catId: null, confidence: 0, candidateIds: [] });
    expect(first.state).toBe("new_cat");
    expect(second).toMatchObject({ state: "new_cat", catId: first.catId });
    expect(await catRows()).toHaveLength(1);
    expect(await wakeupKinds()).toEqual(["cat_queued"]);
  });

  it("two racing finishers make one cat", async () => {
    const s = await pendingSighting(5);
    const [a, b] = await Promise.all([finishSighting(s.id), finishSighting(s.id)]);
    expect(a.catId).toBeTruthy();
    expect(b.catId).toBe(a.catId);
    expect(await catRows()).toHaveLength(1);
    expect(await wakeupKinds()).toEqual(["cat_queued"]);
  });

  it("does not run assess again once a pending sighting has a stored assessment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedCat({});
    const s = await pendingSighting(120);
    script.match = () => new Error("down");
    await retryPendingSightings();
    expect(seen.assess).toBe(1);
    expect((await sightingRows()).find((r) => r.id === s.id)).toMatchObject({ state: "pending" });
    expect((await sightingRows()).find((r) => r.id === s.id)?.assessment).not.toBeNull();
    script.match = noMatch;
    await retryPendingSightings();
    expect(seen.assess).toBe(1);
    expect((await sightingRows()).find((r) => r.id === s.id)).toMatchObject({ state: "new_cat" });
  });

  it("holds no database transaction open across an AI call, and the pending row is already committed", async () => {
    const pool = createTestPool();
    const observed: { open: number; pending: number }[] = [];
    inspect = async () => {
      const open = await pool.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'",
      );
      const pending = await pool.query("select count(*)::int as n from sightings where state = 'pending'");
      observed.push({ open: open.rows[0].n, pending: pending.rows[0].n });
    };
    await seedCat({});
    const u = await makeUser();
    try {
      await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    } finally {
      await pool.end();
    }
    expect(observed.length).toBeGreaterThanOrEqual(2);
    for (const o of observed) expect(o).toEqual({ open: 0, pending: 1 });
  });
});

describe("retryPendingSightings", () => {
  it("takes the oldest first, at most 10 per call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await pendingSighting(1000 - i * 10)).id);
    script.assess = () => assessWith({ is_cat: false });
    const res = await retryPendingSightings();
    expect(res).toMatchObject({ examined: 10, completed: 10 });
    const rows = await sightingRows();
    const left = rows.filter((r) => r.state === "pending").map((r) => r.id);
    expect(left.sort()).toEqual([ids[10], ids[11]].sort());
  });

  it("ignores sightings newer than 60 seconds", async () => {
    await pendingSighting(30);
    expect(await retryPendingSightings()).toMatchObject({ examined: 0, completed: 0 });
    expect(seen.assess).toBe(0);
  });

  it("stops the run when AI is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await pendingSighting(500 - i);
    script.assess = () => new Error("down");
    const res = await retryPendingSightings();
    expect(res).toMatchObject({ completed: 0, stopped: "unavailable" });
    expect(seen.assess).toBe(1);
  });

  it("stops the run when the budget is spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await pendingSighting(500 - i);
    process.env.AI_DAILY_CALL_CAP = "0";
    const res = await retryPendingSightings();
    expect(res).toMatchObject({ completed: 0, stopped: "budget" });
    expect(seen.assess).toBe(0);
    expect((await sightingRows()).every((r) => r.state === "pending")).toBe(true);
  });

  it("carries on past one broken sighting", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await pendingSighting(900);
    await db.update(sightings).set({ originalKey: "originals/00000000-0000-4000-8000-000000000000.jpg" }).where(eq(sightings.id, broken.id));
    const good = await pendingSighting(800);
    const res = await retryPendingSightings();
    expect(res).toMatchObject({ examined: 2, completed: 1 });
    const rows = await sightingRows();
    expect(rows.find((r) => r.id === broken.id)?.state).toBe("pending");
    expect(rows.find((r) => r.id === good.id)?.state).toBe("new_cat");
    expect(JSON.stringify(err.mock.calls)).not.toContain("originals/");
  });
});

describe("rate limit", () => {
  it("refuses an eleventh sighting inside a minute", async () => {
    const u = await makeUser();
    const old = await pendingSighting(300, u.id);
    expect(old.id).toBeTruthy();
    for (let i = 0; i < 9; i++) await pendingSighting(5, u.id);
    await processSpot({ jpeg: await jpeg(), lat: null, lng: null, userId: u.id });
    await expect(
      processSpot({ jpeg: await jpeg(), lat: null, lng: null, userId: u.id }),
    ).rejects.toBeInstanceOf(RateLimited);
  });
});

describe("POST /api/spot", () => {
  async function signIn() {
    const u = await makeUser();
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: "donor", username: u.username }));
    return u;
  }

  async function body(fields: { photo?: Blob | null; lat?: string; lng?: string; sex?: string } = {}) {
    const f = new FormData();
    if (fields.photo !== null) {
      f.set("photo", fields.photo ?? new Blob([new Uint8Array(await jpeg())], { type: "image/jpeg" }), "cat.jpg");
    }
    if (fields.lat !== undefined) f.set("lat", fields.lat);
    if (fields.lng !== undefined) f.set("lng", fields.lng);
    if (fields.sex !== undefined) f.set("sex", fields.sex);
    return f;
  }
  const post = (f: FormData, headers: Record<string, string> = {}) =>
    spotPost(new Request("http://localhost/api/spot", { method: "POST", body: f, headers }));

  it("requires a session", async () => {
    const res = await post(await body());
    expect(res.status).toBe(401);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("returns a whitelisted result with no exact coordinates or keys", async () => {
    await signIn();
    const res = await post(await body({ lat: "10.123456", lng: "120.654321", sex: "female" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["catId", "message", "reveal", "sightingId", "state"]);
    const text = JSON.stringify(json);
    expect(text).not.toContain("10.123456");
    expect(text).not.toContain("120.654321");
    expect(text).not.toMatch(/originals\//);
    // The only storage path allowed is the scrubbed public photo inside the reveal.
    expect(JSON.stringify({ ...json, reveal: null })).not.toMatch(/photos\//);
    const [cat] = await catRows();
    expect(cat.sex).toBe("female");
  });

  it("answers queued_for_ai when AI is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    script.assess = () => new Error("down");
    await signIn();
    const res = await post(await body());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "queued_for_ai" });
  });

  it("rejects a declared body over 10 MB before reading it", async () => {
    await signIn();
    const res = await post(await body(), { "content-length": String(11 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("rejects an undeclared body over 10 MB while streaming it", async () => {
    await signIn();
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 200_000)], { type: "image/jpeg" });
    const res = await post(await body({ photo: big }));
    expect(res.status).toBe(413);
    expect(await sightingRows()).toHaveLength(0);
  });

  it.each([
    ["latitude without longitude", { lat: "10" }],
    ["longitude without latitude", { lng: "120" }],
    ["latitude out of range", { lat: "91", lng: "120" }],
    ["longitude out of range", { lat: "10", lng: "-181" }],
    ["a non-numeric latitude", { lat: "abc", lng: "120" }],
    ["an unknown sex", { sex: "cat" }],
    ["a missing photo", { photo: null }],
  ])("returns 400 for %s", async (_n, fields) => {
    await signIn();
    const res = await post(await body(fields as Parameters<typeof body>[0]));
    expect(res.status).toBe(400);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("returns 415 for a content type other than image/jpeg", async () => {
    await signIn();
    const png = new Blob([new Uint8Array(await jpeg())], { type: "image/png" });
    const res = await post(await body({ photo: png }));
    expect(res.status).toBe(415);
  });

  it("returns 400 for bytes that are not a real image", async () => {
    await signIn();
    const junk = new Blob(["hello"], { type: "image/jpeg" });
    const res = await post(await body({ photo: junk }));
    expect(res.status).toBe(400);
  });

  it("returns 429 past 10 sightings a minute for one user", async () => {
    const u = await signIn();
    for (let i = 0; i < 10; i++) await pendingSighting(5, u.id);
    const res = await post(await body());
    expect(res.status).toBe(429);
    expect(seen.assess).toBe(0);
  });
});
