import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { closePool, db } from "../src/server/db/client";
import { heldCatIds } from "../src/server/reports";
import { cats, earTipFlags, reports, reviewRequests, sightings, users, wakeups } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { checkerImage, greyRegion, variance } from "./helpers/images";
import { createTestPool } from "./helpers/db";
import { CAT_NAMES } from "../src/lib/catNames";
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

// Lets a test make the avatar step, which runs after the phone tier's publish, fail.
const avatarFails = vi.hoisted(() => ({ on: false }));
vi.mock("../src/server/photoAvatar", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/photoAvatar")>();
  return {
    ...real,
    avatarFromPhoto: async (...args: Parameters<typeof real.avatarFromPhoto>) => {
      if (avatarFails.on) throw new Error("avatar failed");
      return real.avatarFromPhoto(...args);
    },
  };
});

import {
  applyAssessment,
  DailyPhotoLimit,
  finishSighting,
  getSpotStatus,
  processSpot,
  PUBLIC_NEW_CATS_PER_DAY,
  PENDING_MAX_AGE_HOURS,
  PUBLIC_PHOTOS_PER_DAY,
  RateLimited,
  retryPendingSightings,
} from "../src/server/spot";
import { getYard } from "../src/server/public";
import { NEUTRAL_AVATAR } from "../src/lib/avatar";
import { GET as statusGet } from "../src/app/api/spot/[id]/route";
import { POST as spotPost } from "../src/app/api/spot/route";
import { POST as reportPost } from "../src/app/api/spot/report/route";
import { POST as earTipPost } from "../src/app/api/cats/[id]/ear-tip/route";

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

async function answerEarTip(userId: string, catId: string, answer: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  jar.set(SESSION_COOKIE, await signSession({ userId, role: "donor", username: u.username }));
  return earTipPost(
    new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }) }),
    { params: Promise.resolve({ id: catId }) },
  );
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
  avatarFails.on = false;
  delete process.env.AI_DAILY_CALL_CAP;
});
afterAll(async () => {
  setAiForTests(null);
  await closePool();
});

describe("processSpot: new cats", () => {
  it("creates a spotted cat with a generated name, bio and a public photo", async () => {
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    const [cat] = await catRows();
    expect(out.catId).toBe(cat.id);
    expect(cat).toMatchObject({
      name: "Muning",
      bio: "A calm orange cat.",
      coatPattern: "tabby",
      // The photo never settles the ear. People's answers do.
      status: "spotted",
      earTipped: null,
      sex: "unknown",
      areaName: COLONY.area_name,
      locationApproximate: false,
    });
    expect(cat.queuedAt).toBeNull();
    expect(await wakeupKinds()).toEqual([]);
    const [s] = await sightingRows();
    expect(s).toMatchObject({ state: "new_cat", catId: cat.id, publicReady: true, caughtByUserId: u.id });
    expect(s.publicKey).toMatch(/^photos\//);
    expect(s.assessment).toMatchObject({ suggested_name: "Muning" });
  });

  it("never judges the ear from the photo: whatever the assessment carries, the cat stays spotted", async () => {
    script.assess = () => assessWith({ ear_tip: "present", ear_tip_confidence: 0.99 });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    expect((await catRows())[0]).toMatchObject({ status: "spotted", earTipped: null, queuedAt: null });
    expect(await wakeupKinds()).toEqual([]);
    expect(JSON.stringify((await sightingRows())[0].assessment)).not.toMatch(/ear_tip/);
  });

  it("a spot carries no ear-tip answer: the cat starts with none, and the finder answers afterwards", async () => {
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [cat] = await catRows();
    expect(await db.select().from(earTipFlags)).toEqual([]);
    expect(cat.status).toBe("spotted");
    expect((await answerEarTip(u.id, cat.id, "no")).status).toBe(200);
    expect((await db.select().from(earTipFlags)).map((f) => [f.catId, f.userId, f.value])).toEqual([[cat.id, u.id, "no"]]);
    expect((await catRows())[0].status).toBe("spotted");
  });

  it("the finder's answers meet the two-neighbour rule: two different people saying No queue, two saying Yes make it neutered", async () => {
    const [a, b, c, d] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: a.id });
    const [cat] = await catRows();
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: b.id });
    await answerEarTip(a.id, cat.id, "no");
    expect((await catRows())[0]).toMatchObject({ status: "spotted" });
    // The same person again changes nothing.
    await answerEarTip(a.id, cat.id, "no");
    expect((await catRows())[0]).toMatchObject({ status: "spotted" });
    await answerEarTip(b.id, cat.id, "no");
    expect((await catRows())[0]).toMatchObject({ status: "queued", earTipped: false });
    expect(await wakeupKinds()).toEqual(["cat_queued"]);

    script.match = () => noMatch();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: c.id });
    const other = (await catRows()).find((x) => x.id !== cat.id)!;
    script.match = () => ({ match_cat_id: other.id, confidence: 0.9, reason: "same" });
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: d.id });
    await answerEarTip(c.id, other.id, "yes");
    await answerEarTip(d.id, other.id, "yes");
    expect((await catRows()).find((x) => x.id === other.id)).toMatchObject({ status: "neutered", earTipped: true });
  });

  it("a review that a caretaker confirms as a new cat starts with no ear-tip answer", async () => {
    script.assess = () => assessWith();
    const u = await makeUser();
    const { key } = await storeOriginal(await jpeg());
    const [s] = await db
      .insert(sightings)
      .values({ originalKey: key, caughtByUserId: u.id, state: "needs_review", assessment: { ...ASSESS, review_reason: "ai_unusable" } })
      .returning();
    const { runAction } = await import("../src/server/caretaker");
    const care = await db.insert(users).values({ username: `care_${Date.now()}`, role: "caretaker" }).returning();
    expect((await runAction("sighting_confirm_new", care[0].id, { sightingId: s.id })).ok).toBe(true);
    expect(await db.select().from(earTipFlags)).toEqual([]);
  });

  it("gives a taken name a free built-in name and falls back for a blank name", async () => {
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    script.assess = () => assessWith({ suggested_name: "   " });
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const names = (await catRows()).map((c) => c.name).sort();
    expect(names).toHaveLength(3);
    expect(names).toContain("Little stray");
    expect(names).toContain("Muning");
    const third = names.find((n) => n !== "Little stray" && n !== "Muning")!;
    expect(CAT_NAMES).toContain(third);
  });

  it("starts unknown, female only for a calico or tortoiseshell coat the server read itself", async () => {
    const u = await makeUser();
    const base = { jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id, ai: true };
    script.assess = () => assessWith({ suggested_name: "A", probably_female_by_coat: true });
    await processSpot(base);
    script.assess = () => assessWith({ suggested_name: "C" });
    await processSpot(base);
    const bySex = Object.fromEntries((await catRows()).map((c) => [c.name, c.sex]));
    expect(bySex).toEqual({ A: "female", C: "unknown" });
  });

  it("writes no flag to the cat, and files a photo report for each claim of kitten, hurt or pregnant", async () => {
    script.assess = () => assessWith({ flags: { kitten: true, pregnant: true, injured: true, sick: false } });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [cat] = await catRows();
    expect(cat.flags).toEqual([]);
    const rows = await db.select().from(reports);
    expect(rows.map((r) => r.claim).sort()).toEqual(["injured", "kitten", "pregnant"]);
    for (const r of rows) {
      expect(r).toMatchObject({ source: "photo", status: "open", catId: cat.id, reporterId: null, note: null, photoAgrees: null });
      expect(r.sightingId).not.toBeNull();
    }
    expect(await wakeupKinds()).toContain("report_changed");
  });

  it("files no report when the photo shows nothing wrong", async () => {
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(await db.select().from(reports)).toHaveLength(0);
  });

  it("a mid band photo with a claim keeps its report with no cat", async () => {
    const { cat } = await seedCat({});
    script.assess = () => assessWith({ flags: { kitten: false, pregnant: false, injured: true, sick: false } });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.6, reason: "maybe" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
    const [r] = await db.select().from(reports);
    expect(r).toMatchObject({ claim: "injured", catId: null, status: "open" });
    expect((await catRows())[0].flags).toEqual([]);
  });

  it("a photo that went to review because the match failed keeps its report too", async () => {
    await seedCat({});
    setAiForTests(async (params) => {
      if (String(params.system).includes("same cat")) return { stop_reason: "refusal", content: [] };
      const flags = { kitten: false, pregnant: false, injured: false, sick: true };
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(assessWith({ flags })) }] };
    });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
    expect(await db.select().from(reports)).toMatchObject([{ claim: "sick", catId: null }]);
  });

  it("a rejected photo files no report", async () => {
    script.assess = () => assessWith({ is_cat: false, flags: { kitten: false, pregnant: false, injured: true, sick: false } });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(await db.select().from(reports)).toHaveLength(0);
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
    const out2 = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out2.state).toBe("rejected");
    expect(out2.catId).toBeUndefined();
    expect(out2.message).toMatch(/try/i);
    const rows = await sightingRows();
    expect(rows.at(-1)).toMatchObject({ state: "rejected", catId: null, publicReady: false, publicKey: null });
    expect(seen.match).toBe(0);
    expect(await catRows()).toHaveLength(1);
  });

  it.each([
    ["screen_or_picture", "That looks like a screen or picture. We need a real cat."],
    ["no_cat", "We couldn't find a cat in that photo."],
    ["too_dark", "It's too dark to see the cat. Try somewhere brighter."],
    ["too_blurry", "The photo is blurry. Hold still and try again."],
    ["too_far", "The cat is too far away. Try a little closer."],
    ["cat_hidden", "We can't see enough of the cat. Try another angle."],
    ["none", "We couldn't use that photo. Try another one."],
  ])("maps reject_reason %s to its fixed message", async (reason, message) => {
    const u = await makeUser();
    script.assess = () => assessWith({ is_cat: false, reject_reason: reason });
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("rejected");
    expect(out.message).toBe(message);
  });

  it("uses the reason for a poor photo of a cat, and the fallback for an unknown reason", async () => {
    const u = await makeUser();
    script.assess = () => assessWith({ cat_visible_quality: "poor", reject_reason: "too_dark" });
    const a = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(a.message).toBe("It's too dark to see the cat. Try somewhere brighter.");
  });
});

describe("processSpot: matching", () => {
  it("adds a sighting to the matched cat and creates no new cat", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same face" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
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
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
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
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
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
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
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
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    expect(await catRows()).toHaveLength(2);
  });

  it("uses the guardrail match threshold", async () => {
    await db.execute((await import("drizzle-orm")).sql`update guardrails set match_confidence_min = 0.95`);
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "close" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
  });

  it("never regresses status: a queued cat stays queued when it is matched again", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("matched");
    expect((await catRows())[0]).toMatchObject({ status: "queued", earTipped: false });
    expect(await wakeupKinds()).toEqual([]);
  });

  it("a Yes from a finder on a queued cat files a review and does not change its status", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out).toMatchObject({ state: "matched", catId: cat.id });
    expect((await answerEarTip(u.id, cat.id, "yes")).status).toBe(200);
    expect((await catRows())[0]).toMatchObject({ status: "queued", earTipped: false });
    expect((await db.select().from(reviewRequests)).filter((r) => r.status === "open")).toHaveLength(1);
  });

  it("leaves a neutered cat alone when it is matched again", async () => {
    const { cat } = await seedCat({ status: "neutered", earTipped: true });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("matched");
    expect((await catRows())[0]).toMatchObject({ status: "neutered", earTipped: true });
  });

  it("a match with no ear-tip answer leaves a spotted cat spotted and queues nothing", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("matched");
    expect((await catRows())[0]).toMatchObject({ status: "spotted", earTipped: null, queuedAt: null });
    expect(await wakeupKinds()).toEqual([]);
  });

  it("keeps confirmed flags, and files a report for a new claim, kitten included, instead of a flag", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false, flags: ["injured"] });
    script.assess = () => assessWith({ flags: { kitten: true, pregnant: true, injured: false, sick: false } });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await catRows())[0].flags).toEqual(["injured"]);
    const filed = await db.select().from(reports);
    expect(filed.map((r) => r.claim).sort()).toEqual(["kitten", "pregnant"]);
    for (const r of filed) expect(r).toMatchObject({ catId: cat.id, status: "open", source: "photo" });
  });

  it("does not pile up reports: a claim already confirmed or already open on the cat is not filed again", async () => {
    const { cat } = await seedCat({ status: "queued", earTipped: false, flags: ["injured"] });
    script.assess = () => assessWith({ flags: { kitten: false, pregnant: true, injured: true, sick: false } });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "same" });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await db.select().from(reports)).map((r) => r.claim)).toEqual(["pregnant"]);
  });

  it("sends to review, not new cat, when the match call is refused", async () => {
    const { cat } = await seedCat({});
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.9, reason: "x" });
    setAiForTests(async (params) => {
      if (String(params.system).includes("same cat")) return { stop_reason: "refusal", content: [] };
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(assessWith()) }] };
    });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("needs_review");
    expect(await catRows()).toHaveLength(1);
    const [s] = await db.select().from(sightings).orderBy(desc(sightings.createdAt));
    expect((s.assessment as { candidate_cat_ids: string[] }).candidate_cat_ids).toEqual([cat.id]);
  });
});

describe("location", () => {
  it("fixes the fuzz at creation; a later sighting changes nothing", async () => {
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [before] = await catRows();
    expect(before.exactLat).toBe(10.2);
    expect(before.exactLng).toBe(120.6);
    const dLat = (before.fuzzedLat! - 10.2) * 111_320;
    const dLng = (before.fuzzedLng! - 120.6) * 111_320 * Math.cos((10.2 * Math.PI) / 180);
    const metres = Math.hypot(dLat, dLng);
    expect(metres).toBeGreaterThan(250);
    expect(metres).toBeLessThan(750);

    script.match = () => ({ match_cat_id: before.id, confidence: 0.9, reason: "same" });
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.3, lng: 120.7, userId: u.id });
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
    await processSpot({ ai: true, jpeg: await jpeg(), lat: null, lng: null, userId: u.id });
    const [cat] = await catRows();
    expect(cat.locationApproximate).toBe(true);
    expect(cat.exactLat).toBe(COLONY.centre.lat);
    expect(cat.exactLng).toBe(COLONY.centre.lng);
    expect(cat.fuzzedLat).not.toBe(COLONY.centre.lat);
  });
});

describe("public photo", () => {
  it("a matched photo that says kitten leaves the cat's flags alone and files a photo kitten report for it", async () => {
    const { cat } = await seedCat({});
    script.assess = () => assessWith({ flags: { kitten: true, pregnant: false, injured: false, sick: false } });
    script.match = () => ({ match_cat_id: cat.id, confidence: 0.99, reason: "same" });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await catRows())[0].flags).not.toContain("kitten");
    expect(await db.select().from(reports)).toMatchObject([{ claim: "kitten", catId: cat.id, source: "photo", status: "open" }]);
  });

  it("publishes cat-only on the AI path: sharp around the stored box, blurred far from it, sensitive regions blurred", async () => {
    script.assess = () => assessWith({ sensitive_regions: [{ x: 0.1, y: 0.4, w: 0.1, h: 0.2 }] });
    const u = await makeUser();
    const photo = await sharp(await checkerImage(400, 300, { left: 0, top: 0, width: 400, height: 300 })).jpeg({ quality: 95 }).toBuffer();
    await processSpot({ ai: true, jpeg: photo, lat: 10.2, lng: 120.6, userId: u.id, box: { x: 0, y: 0.2, w: 0.3, h: 0.6 } });
    const [s] = await sightingRows();
    expect(s.publicReady).toBe(true);
    const out = (getStorage() as unknown as { readPublic(k: string): Buffer }).readPublic(s.publicKey!);
    const varAt = async (img: Buffer, left: number, top: number, width = 20, height = 20) =>
      variance(await greyRegion(img, { left, top, width, height }));
    const sharpVar = await varAt(photo, 20, 100);
    // Box centre is (60, 150), circle radius 120 * 1.3 = 156. The region (40..80, 120..180) is blurred inside it.
    expect(await varAt(out, 85, 100)).toBeGreaterThan(sharpVar * 0.7);
    expect(await varAt(out, 40, 130, 10, 10)).toBeLessThan(sharpVar * 0.1);
    expect(await varAt(out, 360, 20)).toBeLessThan(sharpVar * 0.1);
  });

  it("blurs the assessment's sensitive regions and makes the photo public", async () => {
    script.assess = () => assessWith({ sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [s] = await sightingRows();
    expect(s.publicReady).toBe(true);
    const memory = getStorage() as unknown as { readPublic(k: string): Buffer };
    expect(memory.readPublic(s.publicKey!).length).toBeGreaterThan(0);
  });

  it("holds the photo for a caretaker when the AI does not say nothing sensitive is left, even with no regions", async () => {
    script.assess = () => assessWith({ no_sensitive_content: false, sensitive_regions: [] });
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    const [s] = await sightingRows();
    expect(s).toMatchObject({ publicReady: false, publicKey: null });
    const [cat] = await catRows();
    expect(cat.id).toBe(out.catId);
  });

  it("holds the photo when regions are listed but the AI is not sure the rest is clear", async () => {
    script.assess = () => assessWith({ no_sensitive_content: false, sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await sightingRows())[0]).toMatchObject({ publicReady: false, publicKey: null });
  });

  it("publishes with an empty region list only when the AI says nothing sensitive is left", async () => {
    script.assess = () => assessWith({ no_sensitive_content: true, sensitive_regions: [] });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await sightingRows())[0].publicReady).toBe(true);
  });

  it("an answer without the field is unparseable, so it never reaches publishing", async () => {
    const { no_sensitive_content: _drop, ...without } = ASSESS;
    void _drop;
    script.assess = () => without;
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).not.toBe("new_cat");
    expect((await sightingRows())[0].publicReady).toBe(false);
  });

  it("keeps public_ready false and still creates the cat when publishing fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getStorage(), "putPublic").mockRejectedValue(new Error("disk full"));
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(out.state).toBe("new_cat");
    const [s] = await sightingRows();
    expect(s).toMatchObject({ publicReady: false, publicKey: null, state: "new_cat" });
    expect(err).toHaveBeenCalled();
  });

  it("a rotation during the publish wins: the old-orientation copy is deleted and the photo stays held", async () => {
    const real = getStorage().putPublic.bind(getStorage());
    const keys: string[] = [];
    vi.spyOn(getStorage(), "putPublic").mockImplementationOnce(async (key, buf, type) => {
      keys.push(key);
      await real(key, buf, type);
      await db.update(sightings).set({ photoVersion: 1 });
    });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect(keys).toHaveLength(1);
    expect(() => (getStorage() as unknown as { readPublic(k: string): Buffer }).readPublic(keys[0])).toThrow();
    expect((await sightingRows())[0]).toMatchObject({ publicReady: false, publicKey: null });
  });
});

describe("public words from the photo (I3)", () => {
  it("stores the model's bio when it only describes the cat", async () => {
    script.assess = () => assessWith({ short_bio: "A calm orange cat with white socks." });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    expect((await catRows())[0].bio).toBe("A calm orange cat with white socks.");
  });

  it("replaces a bio that repeats a shop, street, number or area with the generic line", async () => {
    for (const bio of ["Waits outside the Mercury Drug on Rizal Ave.", "Lives at gate 12.", "Naps near the market in San Antonio."]) {
      await db.delete(sightings);
      await db.delete(cats);
      script.assess = () => assessWith({ short_bio: bio });
      const u = await makeUser();
      await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
      expect((await catRows())[0].bio).toBe("A friendly neighbourhood cat.");
    }
  });

  it("does not keep a place or a number as the cat's name", async () => {
    script.assess = () => assessWith({ suggested_name: "Gate 5" });
    const u = await makeUser();
    await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
    const [cat] = await catRows();
    expect(cat.name).not.toMatch(/gate|5/i);
    expect(cat.name.length).toBeGreaterThan(0);
  });
});

describe("processSpot: input and AI outage", () => {
  it("rejects a file that is not an image and writes nothing", async () => {
    const u = await makeUser();
    await expect(
      processSpot({ ai: true, jpeg: Buffer.from("not a photo"), lat: null, lng: null, userId: u.id }),
    ).rejects.toBeInstanceOf(InvalidPhoto);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("keeps the sighting pending when AI is unavailable, then retry completes it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    script.assess = () => new Error("down");
    const u = await makeUser();
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
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
    const out = await processSpot({ ai: true, jpeg: await jpeg(), lat: null, lng: null, userId: u.id });
    expect(out.state).toBe("queued_for_ai");
    expect(seen.assess).toBe(0);
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
    expect(await wakeupKinds()).toEqual([]);
  });

  it("two racing finishers make one cat", async () => {
    const s = await pendingSighting(5);
    const [a, b] = await Promise.all([finishSighting(s.id), finishSighting(s.id)]);
    expect(a.catId).toBeTruthy();
    expect(b.catId).toBe(a.catId);
    expect(await catRows()).toHaveLength(1);
    expect(await wakeupKinds()).toEqual([]);
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
      await processSpot({ ai: true, jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id });
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

  it("sends pending sightings older than a day to review with no AI call, and still retries a fresh one", async () => {
    const stale = await pendingSighting(PENDING_MAX_AGE_HOURS * 3600 + 3600);
    const fresh = await pendingSighting(120);
    script.assess = () => assessWith({ is_cat: false });
    const res = await retryPendingSightings();
    const rows = await sightingRows();
    expect(rows.find((r) => r.id === stale.id)?.state).toBe("needs_review");
    expect(rows.find((r) => r.id === fresh.id)?.state).not.toBe("pending");
    expect(res.examined).toBe(1);
    expect(seen.assess).toBe(1);
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
    await processSpot({ ai: true, jpeg: await jpeg(), lat: null, lng: null, userId: u.id });
    await expect(
      processSpot({ ai: true, jpeg: await jpeg(), lat: null, lng: null, userId: u.id }),
    ).rejects.toBeInstanceOf(RateLimited);
  });
});

describe("POST /api/spot", () => {
  async function signIn() {
    const u = await makeUser();
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: "donor", username: u.username }));
    return u;
  }

  async function body(fields: { photo?: Blob | null; lat?: string; lng?: string; box?: string } = {}) {
    const f = new FormData();
    if (fields.photo !== null) {
      f.set("photo", fields.photo ?? new Blob([new Uint8Array(await jpeg())], { type: "image/jpeg" }), "cat.jpg");
    }
    if (fields.lat !== undefined) f.set("lat", fields.lat);
    if (fields.lng !== undefined) f.set("lng", fields.lng);
    if (fields.box !== undefined) f.set("box", fields.box);
    return f;
  }
  const post = (f: FormData, headers: Record<string, string> = {}) =>
    spotPost(new Request("http://localhost/api/spot", { method: "POST", body: f, headers }));

  describe("for the public (judge gate on, no cookie)", () => {
    beforeEach(() => {
      vi.stubEnv("JUDGE_GATE", "true");
      vi.stubEnv("JUDGE_PASSCODE", "test-judge-code-0000");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("calls no AI, keeps AI wording out of the reply and publishes now on a usable cut-out", async () => {
      await signIn();
      const px = Buffer.alloc(64 * 64);
      for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) px[y * 64 + x] = 255;
      const mask = await sharp(px, { raw: { width: 64, height: 64, channels: 1 } }).png().toBuffer();
      const f = await body({ box: JSON.stringify({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 }) });
      f.set("mask", new Blob([new Uint8Array(mask)], { type: "image/png" }), "mask.png");
      const res = await post(f);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toMatchObject({ state: "new_cat", aiChecked: false, developed: true });
      expect(String(json.message)).not.toContain("AI");
      expect(seen.assess + seen.match).toBe(0);
    });

    it("answers 429 with the sentence once the day's limit is reached", async () => {
      const u = await signIn();
      const { key } = await storeOriginal(await jpeg());
      await db.insert(sightings).values(
        Array.from({ length: PUBLIC_PHOTOS_PER_DAY }, () => ({
          originalKey: key,
          caughtByUserId: u.id,
          state: "new_cat",
        })),
      );
      const res = await post(await body());
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "That's 5 photos today. Try again tomorrow." });
    });
  });

  it("requires a session", async () => {
    const res = await post(await body());
    expect(res.status).toBe(401);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("returns a whitelisted result with no exact coordinates or keys", async () => {
    await signIn();
    const res = await post(await body({ lat: "10.123456", lng: "120.654321" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["aiChecked", "catId", "developed", "message", "reveal", "sightingId", "state"]);
    const text = JSON.stringify(json);
    expect(text).not.toContain("10.123456");
    expect(text).not.toContain("120.654321");
    expect(text).not.toMatch(/originals\//);
    // The only storage path allowed is the scrubbed public photo inside the reveal.
    expect(JSON.stringify({ ...json, reveal: null })).not.toMatch(/photos\//);
    const [cat] = await catRows();
    expect(cat.sex).toBe("unknown");
  });

  it("no longer reads sex or ear-tip fields: a form that still sends them changes nothing", async () => {
    await signIn();
    const f = await body({ lat: "10.1", lng: "120.6" });
    f.set("sex", "female");
    f.set("earTip", "no");
    f.set("sex2", "cat");
    expect((await post(f)).status).toBe(200);
    expect((await catRows())[0].sex).toBe("unknown");
    expect(await db.select().from(earTipFlags)).toEqual([]);
    const [s] = await sightingRows();
    expect(s.requestedSex).toBeNull();
    expect(s.requestedEarTip).toBeNull();
  });

  it("keeps the cat's box from the camera, as fractions of the photo", async () => {
    await signIn();
    const res = await post(await body({ box: JSON.stringify({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }) }));
    expect(res.status).toBe(200);
    const [s] = await sightingRows();
    expect(s.catBox).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
    expect(JSON.stringify(await res.json())).not.toContain("0.5");
  });

  it("stores no box when none is sent", async () => {
    await signIn();
    expect((await post(await body())).status).toBe(200);
    expect((await sightingRows())[0].catBox).toBeNull();
  });

  it("refuses a box that is out of range or not a box, and saves nothing", async () => {
    await signIn();
    for (const box of ["not json", JSON.stringify({ x: 2, y: 0, w: 0.5, h: 0.5 }), JSON.stringify({ x: 0.5, y: 0.5, w: 0.9, h: 0.9 }), JSON.stringify([1, 2])]) {
      expect((await post(await body({ box }))).status).toBe(400);
    }
    expect(await sightingRows()).toHaveLength(0);
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
    expect(((await res.json()) as { error: string }).error).toBe("That photo is too large. Take it again.");
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
    ["a missing photo", { photo: null }],
  ])("returns 400 for %s", async (_n, fields) => {
    await signIn();
    const res = await post(await body(fields as Parameters<typeof body>[0]));
    expect(res.status).toBe(400);
    expect(await sightingRows()).toHaveLength(0);
  });

  it("returns 415 for PNG bytes labelled image/jpeg", async () => {
    await signIn();
    const pngBytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#888" } }).png().toBuffer();
    const res = await post(await body({ photo: new Blob([new Uint8Array(pngBytes)], { type: "image/jpeg" }) }));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("Send a JPEG photo.");
    expect(await sightingRows()).toHaveLength(0);
  });

  it("returns 400 for bytes that are not a real image", async () => {
    await signIn();
    const junk = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03])], { type: "image/jpeg" });
    const res = await post(await body({ photo: junk }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "We couldn't read that photo. Take it again with the camera.",
    );
  });

  it("returns 429 past 10 sightings a minute for one user", async () => {
    const u = await signIn();
    for (let i = 0; i < 10; i++) await pendingSighting(5, u.id);
    const res = await post(await body());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Too many photos in the last minute. Wait a moment and try again.",
    );
    expect(seen.assess).toBe(0);
  });
});

describe("POST /api/spot/report", () => {
  async function signIn() {
    const u = await makeUser();
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: "donor", username: u.username }));
    return u;
  }
  const send = (payload: unknown, type = "application/json") =>
    reportPost(
      new Request("http://localhost/api/spot/report", {
        method: "POST",
        headers: { "content-type": type },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    );
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const reportRows = () => db.select().from(reports);

  /** A photo the user took, matched to a cat, or still waiting on a caretaker when no cat is given. */
  async function photoOf(userId: string | null, opts: { catId?: string | null; ageMinutes?: number } = {}) {
    const { key } = await storeOriginal(await jpeg());
    const [s] = await db
      .insert(sightings)
      .values({
        originalKey: key,
        caughtByUserId: userId,
        catId: opts.catId ?? null,
        state: opts.catId ? "matched" : "needs_review",
        exactLat: 10.2,
        exactLng: 120.6,
      })
      .returning();
    if (opts.ageMinutes) {
      await db.execute(
        (await import("drizzle-orm")).sql`update sightings set created_at = now() - make_interval(mins => ${opts.ageMinutes}) where id = ${s.id}`,
      );
    }
    return s;
  }

  it("needs a signed-in person and a JSON body", async () => {
    expect((await send({})).status).toBe(401);
    await signIn();
    expect((await send("claim=injured", "text/plain")).status).toBe(415);
  });

  it("files a report on the sighting's cat, and the answer is only ok", async () => {
    const u = await signIn();
    const { cat } = await seedCat({});
    const s = await photoOf(u.id, { catId: cat.id });
    const res = await send({ sightingId: s.id, claim: "injured", note: "limping on the left leg" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(await reportRows()).toMatchObject([
      { catId: cat.id, sightingId: s.id, claim: "injured", note: "limping on the left leg", source: "neighbour", reporterId: u.id, status: "open" },
    ]);
  });

  it("takes the cat from the sighting and ignores a catId in the body", async () => {
    const u = await signIn();
    const { cat } = await seedCat({});
    const { cat: other } = await seedCat({});
    const s = await photoOf(u.id, { catId: cat.id });
    const res = await send({ sightingId: s.id, claim: "sick", catId: other.id });
    expect(res.status).toBe(200);
    expect((await reportRows())[0].catId).toBe(cat.id);
  });

  it("files a report for a photo still waiting on a caretaker with no cat, to attach when sorted, and does not promise a check yet", async () => {
    const u = await signIn();
    const s = await photoOf(u.id);
    const res = await send({ sightingId: s.id, claim: "pregnant" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, message: "Thanks. A caretaker sorts the photo first. If that cat was already checked for this, it is closed." });
    expect(await reportRows()).toMatchObject([{ catId: null, sightingId: s.id, claim: "pregnant", status: "open" }]);
  });

  it("a report on a photo the AI has not looked at yet attaches to the cat when the AI settles the photo, and holds it", async () => {
    const u = await signIn();
    const { cat } = await seedCat({});
    const s = await pendingSighting(5, u.id);
    expect((await send({ sightingId: s.id, claim: "injured", note: "limping" })).status).toBe(200);
    expect(await reportRows()).toMatchObject([{ catId: null, status: "open", source: "neighbour" }]);

    await applyAssessment(s.id, assessWith({ flags: { kitten: false, pregnant: false, injured: true, sick: false } }) as never, { catId: cat.id, confidence: 1, candidateIds: [] });
    const rows = await reportRows();
    // The neighbour's own report is the one that holds the cat, and the photo's guess of the same thing adds no second card.
    expect(rows).toMatchObject([{ catId: cat.id, claim: "injured", source: "neighbour", status: "open", reporterId: u.id }]);
    expect(await db.transaction((tx) => heldCatIds(tx))).toEqual(new Set([cat.id]));
  });

  it("and to a new cat the same way", async () => {
    const u = await signIn();
    const s = await pendingSighting(5, u.id);
    await send({ sightingId: s.id, claim: "sick" });
    const out = await applyAssessment(s.id, assessWith() as never, { catId: null, confidence: 0, candidateIds: [] });
    expect(await reportRows()).toMatchObject([{ catId: out.catId, claim: "sick", status: "open" }]);
  });

  it("answers with no coordinates, storage keys or note text", async () => {
    const u = await signIn();
    const { cat } = await seedCat({});
    const s = await photoOf(u.id, { catId: cat.id });
    const res = await send({ sightingId: s.id, claim: "injured", note: "NOTE-SECRET 0917 000 0000" });
    const text = JSON.stringify(await json(res));
    expect(text).not.toMatch(/NOTE-SECRET|10\.2|120\.6|original|key|lat|lng/i);
  });

  it("refuses a missing, malformed or unknown sighting", async () => {
    await signIn();
    expect((await send({ claim: "injured" })).status).toBe(400);
    expect((await send({ sightingId: "nope", claim: "injured" })).status).toBe(400);
    expect((await send({ sightingId: "00000000-0000-4000-8000-000000000000", claim: "injured" })).status).toBe(404);
    expect(await reportRows()).toHaveLength(0);
  });

  it("refuses a sighting caught by someone else, or by nobody", async () => {
    await signIn();
    const other = await makeUser();
    const theirs = await photoOf(other.id);
    const nobody = await photoOf(null);
    expect((await send({ sightingId: theirs.id, claim: "injured" })).status).toBe(404);
    expect((await send({ sightingId: nobody.id, claim: "injured" })).status).toBe(404);
    expect(await reportRows()).toHaveLength(0);
  });

  it("refuses a photo older than 30 minutes, and accepts one just inside", async () => {
    const u = await signIn();
    const old = await photoOf(u.id, { ageMinutes: 31 });
    const fresh = await photoOf(u.id, { ageMinutes: 29 });
    const res = await send({ sightingId: old.id, claim: "injured" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("That photo is too old. Take a new photo to report something.");
    expect((await send({ sightingId: fresh.id, claim: "injured" })).status).toBe(200);
    expect(await reportRows()).toHaveLength(1);
  });

  it("refuses an unknown claim and a note over 280 characters", async () => {
    const u = await signIn();
    const s = await photoOf(u.id);
    expect((await send({ sightingId: s.id, claim: "dead" })).status).toBe(400);
    expect((await send({ sightingId: s.id })).status).toBe(400);
    expect((await send({ sightingId: s.id, claim: "sick", note: "x".repeat(281) })).status).toBe(400);
    expect((await send({ sightingId: s.id, claim: "sick", note: 5 })).status).toBe(400);
    expect(await reportRows()).toHaveLength(0);
    expect((await send({ sightingId: s.id, claim: "sick", note: "x".repeat(280) })).status).toBe(200);
  });

  it("keeps a blank note as no note", async () => {
    const u = await signIn();
    const s = await photoOf(u.id);
    await send({ sightingId: s.id, claim: "kitten", note: "   " });
    expect((await reportRows())[0].note).toBeNull();
  });

  it("answers a repeat today, or a claim a caretaker already dismissed, with a plain message and not an error", async () => {
    const u = await signIn();
    const { cat } = await seedCat({});
    const s = await photoOf(u.id, { catId: cat.id });
    expect((await json(await send({ sightingId: s.id, claim: "sick" })))).toEqual({ ok: true });
    const again = await send({ sightingId: s.id, claim: "sick" });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ ok: true, message: "You already told us about this today." });

    await db.update(reports).set({ status: "dismissed" });
    await db.execute((await import("drizzle-orm")).sql`update reports set reported_on = reported_on - 1`);
    const s2 = await photoOf(u.id, { catId: cat.id });
    const dismissed = await send({ sightingId: s2.id, claim: "sick" });
    expect(dismissed.status).toBe(200);
    expect(await json(dismissed)).toEqual({ ok: true, message: "A caretaker already checked this." });
    expect(await reportRows()).toHaveLength(1);
  });

  it("files one report when the same photo is reported twice with no cat yet, whatever the retry", async () => {
    const u = await signIn();
    const s = await photoOf(u.id);
    expect((await json(await send({ sightingId: s.id, claim: "injured", note: "limping" }))).ok).toBe(true);
    const again = await send({ sightingId: s.id, claim: "injured", note: "limping" });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ ok: true, message: "You already told us about this today." });
    const both = await Promise.all([send({ sightingId: s.id, claim: "sick" }), send({ sightingId: s.id, claim: "sick" })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect((await reportRows()).map((r) => r.claim).sort()).toEqual(["injured", "sick"]);
  });

  it("refuses a photo the AI or a caretaker rejected, like an unknown one", async () => {
    const u = await signIn();
    const s = await photoOf(u.id);
    await db.update(sightings).set({ state: "rejected" }).where(eq(sightings.id, s.id));
    expect((await send({ sightingId: s.id, claim: "injured" })).status).toBe(404);
    expect(await reportRows()).toHaveLength(0);
  });
});

describe("processSpot: the public path (no AI)", () => {
  const BOX = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };

  async function maskOf(on: { x: number; y: number; w: number; h: number } | null): Promise<Buffer> {
    const px = Buffer.alloc(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const fx = (x + 0.5) / 64;
        const fy = (y + 0.5) / 64;
        if (on && fx >= on.x && fx <= on.x + on.w && fy >= on.y && fy <= on.y + on.h) px[y * 64 + x] = 255;
      }
    }
    return sharp(px, { raw: { width: 64, height: 64, channels: 1 } }).png().toBuffer();
  }
  const plain = async (userId: string, more: Record<string, unknown> = {}) =>
    processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId, ai: false, ...more });

  it("puts the cat in the yard at once with no AI call, no assessment and no AI wording", async () => {
    const u = await makeUser();
    const out = await plain(u.id);
    expect(out).toMatchObject({ state: "new_cat", aiChecked: false, developed: false });
    expect(out.message).not.toContain("AI");
    expect(seen.assess + seen.match).toBe(0);
    const yard = await getYard(u.id);
    const mine = yard.cats.find((c) => c.id === out.catId);
    expect(mine).toMatchObject({ yours: true, avatar: NEUTRAL_AVATAR });
    const [s] = await sightingRows();
    expect(s).toMatchObject({ publicReady: false, developedAt: null, assessment: null, needsDevelop: true, developAttempts: 0 });
    const [cat] = await catRows();
    expect(cat.avatar).toBeNull();
    expect((await retryPendingSightings()).examined).toBe(0);
    expect(seen.assess + seen.match).toBe(0);
  });

  it("needs no box", async () => {
    const u = await makeUser();
    expect((await plain(u.id, { box: null })).state).toBe("new_cat");
  });

  it("phone tier: a usable mask publishes now and takes the cat's colours from the photo", async () => {
    const u = await makeUser();
    const out = await plain(u.id, { box: BOX, mask: await maskOf({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }) });
    expect(out.developed).toBe(true);
    const [s] = await sightingRows();
    expect(s.publicReady).toBe(true);
    expect(s.publicKey).not.toBeNull();
    expect(s.developedAt).not.toBeNull();
    expect(s.needsDevelop).toBe(true);
    expect(out.aiChecked).toBe(false);
    // Read back from the row, a developed plain photo still reports no AI and the plain wording.
    expect(await finishSighting(out.sightingId)).toMatchObject({ aiChecked: false, developed: true, message: out.message });
    expect(await getSpotStatus(u.id, out.sightingId)).toMatchObject({ developed: true });
    const [cat] = await catRows();
    expect(cat.avatar).not.toBeNull();
    expect(cat.avatar).not.toEqual(NEUTRAL_AVATAR);
    expect(seen.assess + seen.match).toBe(0);
  });

  it("phone tier: an unusable mask leaves the photo queued", async () => {
    const u = await makeUser();
    const out = await plain(u.id, { box: BOX, mask: await maskOf(null) });
    expect(out.developed).toBe(false);
    const [s] = await sightingRows();
    expect(s).toMatchObject({ publicReady: false, developedAt: null, needsDevelop: true });
  });

  it("phone tier: a copy that lost the develop race is deleted", async () => {
    const u = await makeUser();
    const storage = getStorage() as unknown as { readPublic: (k: string) => Buffer };
    const real = getStorage().putPublic.bind(getStorage());
    const keys: string[] = [];
    vi.spyOn(getStorage(), "putPublic").mockImplementationOnce(async (key, buf, type) => {
      keys.push(key);
      await real(key, buf, type);
      await db.update(sightings).set({ developedAt: new Date() });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await plain(u.id, { box: BOX, mask: await maskOf({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }) });
    expect(out.developed).toBe(false);
    expect(keys).toHaveLength(1);
    expect(() => storage.readPublic(keys[0])).toThrow();
    const [s] = await sightingRows();
    expect(s.publicKey).toBeNull();
  });

  it("phone tier: a failure after the publish deletes the copy it made", async () => {
    const u = await makeUser();
    const storage = getStorage() as unknown as { readPublic: (k: string) => Buffer };
    const real = getStorage().putPublic.bind(getStorage());
    const keys: string[] = [];
    vi.spyOn(getStorage(), "putPublic").mockImplementationOnce(async (key, buf, type) => {
      keys.push(key);
      await real(key, buf, type);
    });
    // The look-alike is read after the publish, so its failure leaves a copy behind unless it is cleaned up.
    avatarFails.on = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await plain(u.id, { box: BOX, mask: await maskOf({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }) });
    expect(out.developed).toBe(false);
    expect(keys).toHaveLength(1);
    expect(() => storage.readPublic(keys[0])).toThrow();
    const [s] = await sightingRows();
    expect(s).toMatchObject({ needsDevelop: true, developedAt: null, publicReady: false, publicKey: null });
  });

  it("phone tier: a rotation during the publish wins, and the old-orientation copy is deleted", async () => {
    const u = await makeUser();
    const storage = getStorage() as unknown as { readPublic: (k: string) => Buffer };
    const real = getStorage().putPublic.bind(getStorage());
    const keys: string[] = [];
    vi.spyOn(getStorage(), "putPublic").mockImplementationOnce(async (key, buf, type) => {
      keys.push(key);
      await real(key, buf, type);
      await db.update(sightings).set({ photoVersion: 1 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await plain(u.id, { box: BOX, mask: await maskOf({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }) });
    expect(out.developed).toBe(false);
    expect(() => storage.readPublic(keys[0])).toThrow();
    const [s] = await sightingRows();
    expect(s).toMatchObject({ developedAt: null, publicKey: null, photoVersion: 1 });
  });

  it("phone tier: a publish that throws leaves the photo for the worker", async () => {
    const u = await makeUser();
    const storage = getStorage();
    vi.spyOn(storage, "putPublic").mockRejectedValueOnce(new Error("storage down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await plain(u.id, { box: BOX, mask: await maskOf({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }) });
    expect(out.developed).toBe(false);
    const [s] = await sightingRows();
    expect(s).toMatchObject({ needsDevelop: true, developedAt: null, publicReady: false });
  });

  it("never lets concurrent uploads pass the site's 50 a day", async () => {
    const filler = await makeUser();
    const { key } = await storeOriginal(await jpeg());
    await db.insert(sightings).values(
      Array.from({ length: PUBLIC_NEW_CATS_PER_DAY - 1 }, () => ({ originalKey: key, caughtByUserId: filler.id, state: "new_cat", needsDevelop: true })),
    );
    const users3 = [await makeUser(), await makeUser(), await makeUser()];
    const outs = await Promise.allSettled(users3.map((u) => plain(u.id)));
    expect(outs.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const bad = outs.filter((o) => o.status === "rejected");
    expect(bad).toHaveLength(2);
    for (const b of bad) expect((b as PromiseRejectedResult).reason).toBeInstanceOf(DailyPhotoLimit);
  });

  it("getSpotStatus tells the owner, and only the owner", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const out = await plain(u.id);
    expect(await getSpotStatus(u.id, out.sightingId)).toEqual({ developed: false, photoUrl: null, avatar: NEUTRAL_AVATAR });
    expect(await getSpotStatus(other.id, out.sightingId)).toBeNull();
  });

  it("GET /api/spot/[id] answers the owner and 404s anyone else", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const out = await plain(u.id);
    const ask = async (who: typeof u) => {
      jar.set(SESSION_COOKIE, await signSession({ userId: who.id, role: "donor", username: who.username }));
      return statusGet(new Request("http://x/api"), { params: Promise.resolve({ id: out.sightingId }) });
    };
    const mine = await ask(u);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ developed: false, photoUrl: null });
    expect((await ask(other)).status).toBe(404);
  });

  it("refuses a 6th photo from one account on a Manila day, with the account sentence", async () => {
    const u = await makeUser();
    for (let n = 0; n < PUBLIC_PHOTOS_PER_DAY; n++) {
      await plain(u.id);
      // Spread them out so the per-minute limit stays out of the way.
      await db.execute((await import("drizzle-orm")).sql`update sightings set created_at = created_at - interval '2 minutes' where caught_by_user_id = ${u.id}`);
    }
    // Refused before the decode: no private original is written for a photo that makes no row.
    const put = vi.spyOn(getStorage(), "putPrivate");
    const err = await plain(u.id).catch((e) => e);
    expect(err).toBeInstanceOf(DailyPhotoLimit);
    expect(err.message).toBe("That's 5 photos today. Try again tomorrow.");
    expect(put).not.toHaveBeenCalled();
    expect(await retryPendingSightings()).toMatchObject({ examined: 0 });
    expect(seen.assess + seen.match).toBe(0);
  });

  it("refuses a fresh account once the site has taken its 50 plain cats today", async () => {
    const filler = await makeUser();
    const { key } = await storeOriginal(await jpeg());
    await db.insert(sightings).values(
      Array.from({ length: PUBLIC_NEW_CATS_PER_DAY }, () => ({ originalKey: key, caughtByUserId: filler.id, state: "new_cat", needsDevelop: true })),
    );
    const u = await makeUser();
    const err = await plain(u.id).catch((e) => e);
    expect(err).toBeInstanceOf(DailyPhotoLimit);
    expect(err.message).toBe("The yard is full for today. Try again tomorrow.");
  });

  it("leaves needs_develop false on AI-path and seeded sightings", async () => {
    const u = await makeUser();
    await seedCat({});
    await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id, ai: true });
    const rows = await sightingRows();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.needsDevelop === false)).toBe(true);
  });

  it("the AI path still reports aiChecked", async () => {
    const u = await makeUser();
    const out = await processSpot({ jpeg: await jpeg(), lat: 10.2, lng: 120.6, userId: u.id, ai: true });
    expect(out).toMatchObject({ state: "new_cat", aiChecked: true });
    expect(seen.assess).toBe(1);
  });
});
