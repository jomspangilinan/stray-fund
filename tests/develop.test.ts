import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { closePool, db } from "../src/server/db/client";
import { cats, sightings, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { setAiForTests } from "../src/server/ai/client";
import { findCat, setCatFinderForTests, type Found } from "../src/server/catFinder";
import { DEVELOP_MAX_ATTEMPTS, DEVELOP_TIMEOUT_MS, developNext } from "../src/server/develop";
import { catOnly, maskUsable, storeOriginal, type Box } from "../src/server/photos";
import { getStorage, memoryStorage } from "../src/server/storage";
import { PHONE_TIER_GRACE_SECONDS, processSpot } from "../src/server/spot";

const GINGER = { r: 0xe8, g: 0xa1, b: 0x5a };
const CAT_BOX: Box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const MIDDLE: Box = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
const W = 320;
const H = 240;

/** A black and white checkerboard with a solid ginger cat over `cat`. The texture makes each keep area publish differently. */
async function photo(cat: Box): Promise<Buffer> {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const inCat = x >= cat.x * W && x < (cat.x + cat.w) * W && y >= cat.y * H && y < (cat.y + cat.h) * H;
      const v = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 0 : 255;
      [px[i], px[i + 1], px[i + 2]] = inCat ? [GINGER.r, GINGER.g, GINGER.b] : [v, v, v];
    }
  }
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

/** A 64x64 grey PNG, white over `on`. */
async function maskOf(on: Box): Promise<Buffer> {
  const px = Buffer.alloc(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const fx = (x + 0.5) / 64;
      const fy = (y + 0.5) / 64;
      if (fx >= on.x && fx <= on.x + on.w && fy >= on.y && fy <= on.y + on.h) px[y * 64 + x] = 255;
    }
  }
  return sharp(px, { raw: { width: 64, height: 64, channels: 1 } }).png().toBuffer();
}

let seq = 0;
async function makeUser() {
  const [u] = await db
    .insert(users)
    .values({ username: `developer_${Date.now()}_${++seq}`, role: "donor" })
    .returning();
  return u;
}

/** A public photo, aged past the phone tier's grace so the worker may take it. */
async function queued(jpeg: Buffer, ageSeconds = PHONE_TIER_GRACE_SECONDS + 60) {
  const u = await makeUser();
  const out = await processSpot({ ai: false, jpeg, lat: null, lng: null, userId: u.id });
  expect(out.developed).toBe(false);
  await db.execute(sql`update sightings set created_at = now() - make_interval(secs => ${ageSeconds}) where id = ${out.sightingId}`);
  return out;
}

const sightingOf = async (id: string) => (await db.select().from(sightings).where(eq(sightings.id, id)))[0];
const catOf = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0];
const published = async (id: string) => memoryStorage.readPublic((await sightingOf(id)).publicKey!);
const original = async (id: string) => getStorage().getPrivate((await sightingOf(id)).originalKey);

let calls = 0;
function finder(f: () => Promise<Found> | Found) {
  setCatFinderForTests(async () => {
    calls++;
    return f();
  });
}

beforeEach(async () => {
  await truncateAll();
  calls = 0;
  // The public path never calls the AI. Any call fails the test.
  setAiForTests(async () => {
    throw new Error("the AI was called");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setCatFinderForTests(null);
});
afterAll(async () => {
  setAiForTests(null);
  await closePool();
});

describe("developNext", () => {
  it("publishes the cat's cut-out and takes the cat's colours from the photo", async () => {
    const mask = await maskOf(CAT_BOX);
    finder(() => ({ box: CAT_BOX, mask }));
    const out = await queued(await photo(CAT_BOX));
    expect((await catOf(out.catId!)).avatar).toBeNull();

    expect(await developNext()).toBe("developed");

    const s = await sightingOf(out.sightingId);
    expect(s.publicReady).toBe(true);
    expect(s.publicKey).toMatch(/^photos\//);
    expect(s.developedAt).not.toBeNull();
    // The claim that publishes is not a failed attempt.
    expect(s.developAttempts).toBe(0);
    expect((await catOf(out.catId!)).avatar).toEqual({ pattern: "solid", base: "ginger", accent: "ginger" });

    const orig = await original(out.sightingId);
    const bytes = await published(out.sightingId);
    expect(bytes.equals(await catOnly(orig, { box: CAT_BOX, mask }))).toBe(true);
    // The mask decided what stayed sharp, not the circle on the box.
    expect(bytes.equals(await catOnly(orig, { box: CAT_BOX, mask: null }))).toBe(false);
  });

  it("with no cat found, still publishes, with the middle circle, and reads colours from the middle", async () => {
    finder(() => ({ box: null, mask: null }));
    const out = await queued(await photo(MIDDLE));

    expect(await developNext()).toBe("developed");

    const s = await sightingOf(out.sightingId);
    expect(s.publicReady).toBe(true);
    expect(s.developedAt).not.toBeNull();
    const orig = await original(out.sightingId);
    const bytes = await published(out.sightingId);
    expect(bytes.equals(await catOnly(orig, { box: null, mask: null }))).toBe(true);
    expect(bytes.equals(await catOnly(orig, { box: CAT_BOX, mask: null }))).toBe(false);
    expect((await catOf(out.catId!)).avatar).toEqual({ pattern: "solid", base: "ginger", accent: "ginger" });
  });

  it("publishes with the middle circle when the finder runs past the time limit", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let signal: AbortSignal | undefined;
    setCatFinderForTests(async (_jpeg, s) => {
      signal = s;
      started();
      return new Promise<Found>(() => {});
    });
    const out = await queued(await photo(MIDDLE));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = developNext();
    await running;
    await vi.advanceTimersByTimeAsync(DEVELOP_TIMEOUT_MS - 1);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    vi.useRealTimers();
    expect(await result).toBe("developed");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("ran out of time"));

    const s = await sightingOf(out.sightingId);
    expect(s.publicReady).toBe(true);
    const orig = await original(out.sightingId);
    expect((await published(out.sightingId)).equals(await catOnly(orig, { box: null, mask: null }))).toBe(true);
  });

  it("publishes with the middle circle on the first claim when the finder throws (R15)", async () => {
    finder(() => {
      throw new Error("model failed to load");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await queued(await photo(MIDDLE));

    expect(await developNext()).toBe("developed");
    expect(calls).toBe(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("model failed to load"));
    const s = await sightingOf(out.sightingId);
    expect(s.developAttempts).toBe(0);
    expect(s.publicReady).toBe(true);
    expect(s.developedAt).not.toBeNull();
    const orig = await original(out.sightingId);
    expect((await published(out.sightingId)).equals(await catOnly(orig, { box: null, mask: null }))).toBe(true);
    expect((await catOf(out.catId!)).avatar).toEqual({ pattern: "solid", base: "ginger", accent: "ginger" });
  });

  it("after DEVELOP_MAX_ATTEMPTS failed claims, publishes with the middle circle and no model call", async () => {
    finder(() => ({ box: CAT_BOX, mask: null }));
    const out = await queued(await photo(MIDDLE));
    await db.update(sightings).set({ developAttempts: DEVELOP_MAX_ATTEMPTS }).where(eq(sightings.id, out.sightingId));

    expect(await developNext()).toBe("developed");
    expect(calls).toBe(0);
    const s = await sightingOf(out.sightingId);
    expect(s.developAttempts).toBe(DEVELOP_MAX_ATTEMPTS);
    expect(s.publicReady).toBe(true);
    const orig = await original(out.sightingId);
    expect((await published(out.sightingId)).equals(await catOnly(orig, { box: null, mask: null }))).toBe(true);
  });

  it("a photo that can never publish sinks behind the healthy ones", async () => {
    finder(() => ({ box: null, mask: null }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await queued(await photo(MIDDLE), 600);
    const healthy = await queued(await photo(MIDDLE), 120);
    const brokenKey = (await sightingOf(broken.sightingId)).originalKey;
    const real = memoryStorage.getPrivate.bind(memoryStorage);
    vi.spyOn(memoryStorage, "getPrivate").mockImplementation(async (key) => {
      if (key === brokenKey) throw new Error("storage down");
      return real(key);
    });

    const results: string[] = [];
    for (let i = 0; i < 5 && (await sightingOf(healthy.sightingId)).developedAt === null; i++) results.push(await developNext());
    expect((await sightingOf(healthy.sightingId)).developedAt).not.toBeNull();
    expect(results.length).toBeLessThanOrEqual(5);
    const b = await sightingOf(broken.sightingId);
    expect(b.developedAt).toBeNull();
    expect(b.developAttempts).toBe(DEVELOP_MAX_ATTEMPTS + 1);
    // Only the error's class name is logged for storage errors.
    expect(logged.mock.calls.flat().join(" ")).not.toContain("storage down");

    // Once past the limit it is still tried, after everything else, and logged loudly.
    await db.update(sightings).set({ developAttempts: DEVELOP_MAX_ATTEMPTS + 3 }).where(eq(sightings.id, broken.sightingId));
    expect(await developNext()).toBe("idle");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`sighting ${broken.sightingId} has failed to publish`));
  });

  describe("with CAT_FINDER=off", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("publishes with no model call, on a circle around the phone's box", async () => {
      vi.stubEnv("CAT_FINDER", "off");
      finder(() => ({ box: CAT_BOX, mask: null }));
      const out = await queued(await photo(CAT_BOX));
      await db.update(sightings).set({ catBox: CAT_BOX }).where(eq(sightings.id, out.sightingId));

      expect(await developNext()).toBe("developed");
      expect(calls).toBe(0);
      const s = await sightingOf(out.sightingId);
      expect(s.publicReady).toBe(true);
      const orig = await original(out.sightingId);
      expect((await published(out.sightingId)).equals(await catOnly(orig, { box: CAT_BOX, mask: null }))).toBe(true);
    });

    it("publishes on the middle circle when no box is known", async () => {
      vi.stubEnv("CAT_FINDER", "off");
      finder(() => ({ box: CAT_BOX, mask: null }));
      const out = await queued(await photo(MIDDLE));

      expect(await developNext()).toBe("developed");
      expect(calls).toBe(0);
      const orig = await original(out.sightingId);
      expect((await published(out.sightingId)).equals(await catOnly(orig, { box: null, mask: null }))).toBe(true);
    });

    it("anything but exactly \"off\" leaves the model on", async () => {
      vi.stubEnv("CAT_FINDER", "OFF");
      finder(() => ({ box: null, mask: null }));
      await queued(await photo(MIDDLE));
      expect(await developNext()).toBe("developed");
      expect(calls).toBe(1);
    });
  });

  it("never takes a sighting from the AI path", async () => {
    finder(() => ({ box: CAT_BOX, mask: null }));
    const u = await makeUser();
    const { key } = await storeOriginal(await photo(CAT_BOX));
    const [judge] = await db
      .insert(sightings)
      .values({ originalKey: key, caughtByUserId: u.id, state: "new_cat" })
      .returning();
    await db.execute(sql`update sightings set created_at = now() - interval '1 hour' where id = ${judge.id}`);

    expect(await developNext()).toBe("idle");
    expect(calls).toBe(0);
    const s = await sightingOf(judge.id);
    expect(s.developAttempts).toBe(0);
    expect(s.publicReady).toBe(false);
    expect(s.developedAt).toBeNull();
  });

  it("leaves a photo alone while the phone tier may still be publishing it", async () => {
    finder(() => ({ box: null, mask: null }));
    const out = await queued(await photo(MIDDLE), PHONE_TIER_GRACE_SECONDS - 10);
    expect(await developNext()).toBe("idle");
    expect(calls).toBe(0);
    expect((await sightingOf(out.sightingId)).developAttempts).toBe(0);
  });

  it("skips a photo the phone tier already developed", async () => {
    finder(() => ({ box: null, mask: null }));
    const u = await makeUser();
    const out = await processSpot({
      ai: false,
      jpeg: await photo(CAT_BOX),
      lat: null,
      lng: null,
      userId: u.id,
      box: CAT_BOX,
      mask: await maskOf(CAT_BOX),
    });
    expect(out.developed).toBe(true);
    await db.execute(sql`update sightings set created_at = now() - interval '1 hour' where id = ${out.sightingId}`);
    expect(await developNext()).toBe("idle");
    expect(calls).toBe(0);
  });

  it("develops the oldest photo first, one per call", async () => {
    finder(() => ({ box: null, mask: null }));
    const newer = await queued(await photo(MIDDLE), 120);
    const older = await queued(await photo(MIDDLE), 300);
    expect(await developNext()).toBe("developed");
    expect((await sightingOf(older.sightingId)).developedAt).not.toBeNull();
    expect((await sightingOf(newer.sightingId)).developedAt).toBeNull();
    expect(await developNext()).toBe("developed");
    expect((await sightingOf(newer.sightingId)).developedAt).not.toBeNull();
    expect(await developNext()).toBe("idle");
  });

  it("does not overwrite a photo another publisher developed while the model ran", async () => {
    let otherKey = "";
    const out = await queued(await photo(MIDDLE));
    setCatFinderForTests(async () => {
      otherKey = "photos/00000000-0000-4000-8000-000000000000.jpg";
      await db
        .update(sightings)
        .set({ publicKey: otherKey, publicReady: true, developedAt: new Date() })
        .where(eq(sightings.id, out.sightingId));
      return { box: CAT_BOX, mask: null };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await developNext()).toBe("developed");
    expect((await sightingOf(out.sightingId)).publicKey).toBe(otherKey);
    // The cat keeps its grey look-alike: only the winner sets the colours.
    expect((await catOf(out.catId!)).avatar).toBeNull();
  });
});

describe("findCat with the real model", () => {
  // The cat photos are gitignored (their licences), so the Ultralytics comparison runs only where they exist.
  const CAT_PHOTO = path.join(__dirname, "fixtures", "vision", "cat-intact-1.jpg");

  it.skipIf(!existsSync(CAT_PHOTO))("finds the cat where Ultralytics does, with a cut-out the server accepts", async () => {
    const found = await findCat(await readFile(CAT_PHOTO), new AbortController().signal);
    // Ultralytics 8.4 on the same ONNX file: x 0.328, y 0.128, w 0.285, h 0.635.
    expect(found.box!.x).toBeCloseTo(0.328, 2);
    expect(found.box!.y).toBeCloseTo(0.128, 2);
    expect(found.box!.w).toBeCloseTo(0.285, 2);
    expect(found.box!.h).toBeCloseTo(0.635, 2);
    expect(await maskUsable(found.mask!, found.box)).toBe(true);
  });

  it("finds no cat in a checkerboard", async () => {
    expect(await findCat(await photo({ x: 0, y: 0, w: 0, h: 0 }), new AbortController().signal)).toEqual({ box: null, mask: null });
  });

  it("gives up when the signal has already fired", async () => {
    const stop = new AbortController();
    stop.abort(new Error("stop"));
    await expect(findCat(await photo(CAT_BOX), stop.signal)).rejects.toThrow("stop");
  });
});
