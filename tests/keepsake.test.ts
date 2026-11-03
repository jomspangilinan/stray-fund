import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatAvatar } from "../src/components/CatAvatar";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, closePool } from "../src/server/db/client";
import { cats, sightings } from "../src/server/db/schema";
import { RIBBON, type Avatar } from "../src/lib/avatar";
import { cropRect, fromCatBox, keepsakeDate, keepsakeFileName, otherCats, parseCatBox, PHOTO_BOX, standaloneSvg, titleName, toCatBox } from "../src/lib/keepsake";
import { getStorage, newPublicKey } from "../src/server/storage";
import { getKeepsake } from "../src/server/keepsake";
import { getCatCard } from "../src/server/public";
import { GET as dataGet } from "../src/app/api/cats/[id]/keepsake/route";
import { GET as photoGet } from "../src/app/api/cats/[id]/keepsake/photo/route";
import { truncateAll } from "./helpers/db";

const A = PHOTO_BOX.w / PHOTO_BOX.h;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("keepsakeDate", () => {
  it("writes the day, short month and year, as people say it", () => {
    expect(keepsakeDate(new Date(2026, 10, 3, 14, 5))).toBe("3 Nov 2026");
    expect(keepsakeDate(new Date(2027, 0, 21))).toBe("21 Jan 2027");
  });
});

describe("cropRect", () => {
  it("centres a frame-shaped crop when there is no cat box", () => {
    const r = cropRect({ w: 1600, h: 1200 }, null);
    expect(r.w / r.h).toBeCloseTo(A, 5);
    expect(r.x + r.w / 2).toBeCloseTo(800, 5);
    expect(r.y + r.h / 2).toBeCloseTo(600, 5);
  });

  it("goes tight around a small cat and stays inside the photo", () => {
    const r = cropRect({ w: 1600, h: 1200 }, { x: 1300, y: 900, w: 200, h: 200 });
    expect(r.w).toBeLessThan(800);
    expect(r.w / r.h).toBeCloseTo(A, 5);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1600 + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(1200 + 1e-6);
    // The whole cat is in view.
    expect(r.x).toBeLessThanOrEqual(1300);
    expect(r.x + r.w).toBeGreaterThanOrEqual(1500);
    expect(r.y + r.h).toBeGreaterThanOrEqual(1100);
  });

  it("never zooms past the photo, and ignores a useless box", () => {
    const whole = cropRect({ w: 1000, h: 1000 }, { x: 0, y: 0, w: 1000, h: 1000 });
    expect(whole.w).toBeLessThanOrEqual(1000);
    expect(cropRect({ w: 1000, h: 1000 }, { x: 5, y: 5, w: 0, h: 10 })).toEqual(cropRect({ w: 1000, h: 1000 }, null));
  });
});

describe("parseCatBox", () => {
  it("accepts a box inside the photo and keeps only its four numbers", () => {
    expect(parseCatBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.4, extra: "no" })).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
    expect(parseCatBox({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("refuses anything out of range or not numbers", () => {
    for (const bad of [
      null, "x", 5, [], {}, { x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0, h: 0.5 }, { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.7, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 1.5, h: 0.5 }, { x: "0", y: 0, w: 0.5, h: 0.5 },
      { x: NaN, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: Infinity, h: 0.5 },
    ]) expect(parseCatBox(bad)).toBeNull();
  });
  it("turns a box in video pixels into fractions, clamped, or nothing when it is useless", () => {
    expect(toCatBox({ x: 100, y: 50, w: 200, h: 100 }, { w: 400, h: 200 })).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(toCatBox({ x: -20, y: 0, w: 100, h: 100 }, { w: 400, h: 200 })).toEqual({ x: 0, y: 0, w: 0.2, h: 0.5 });
    expect(toCatBox({ x: 0, y: 0, w: 0, h: 10 }, { w: 400, h: 200 })).toBeNull();
    expect(toCatBox({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 0 })).toBeNull();
  });
  it("lets the crop use a stored box and fall back to the centre without one", () => {
    const photo = { w: 1600, h: 1200 };
    const tight = cropRect(photo, fromCatBox({ x: 0.8, y: 0.7, w: 0.12, h: 0.16 }, photo));
    expect(tight.w).toBeLessThan(700);
    expect(cropRect(photo, fromCatBox(null, photo))).toEqual(cropRect(photo, null));
  });
});

describe("title and file name", () => {
  it("cuts a long name at 30 letters with an ellipsis and leaves a short one alone", () => {
    expect(titleName("Bituin")).toBe("Bituin");
    const long = titleName("Maria Clara de la Santissima Trinidad del Rosario");
    expect(Array.from(long).length).toBeLessThanOrEqual(30);
    expect(long.endsWith("…")).toBe(true);
  });
  it("names the file from the cat's name only", () => {
    expect(keepsakeFileName("Bituin")).toBe("bituin-stray-fund.png");
    expect(keepsakeFileName("Ningning & Co.")).toBe("ningning-co-stray-fund.png");
    expect(keepsakeFileName("猫")).toBe("cat-stray-fund.png");
  });
});

describe("otherCats", () => {
  it("leaves out this cat and keeps at most four", () => {
    const yard = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    expect(otherCats(yard, "b").map((c) => c.id)).toEqual(["a", "c", "d", "e"]);
    expect(otherCats([{ id: "a" }], "a")).toEqual([]);
  });
});

describe("standaloneSvg", () => {
  const a: Avatar = { pattern: "tabby", base: "brown", accent: "ginger" };
  it("is a self-contained drawing, with the ribbon only for a girl", () => {
    const girl = standaloneSvg(renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id: "cat-1", ribbon: true })));
    expect(girl).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(girl).toContain('width="400"');
    expect(girl).toContain(RIBBON);
    expect(girl).not.toContain("<script");
    expect(standaloneSvg(renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id: "cat-1" })))).not.toContain(RIBBON);
  });
});

describe("keepsake data and photo", () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  async function cat(name: string, photo = true, sex = "unknown") {
    const [c] = await db.insert(cats).values({ name, areaName: "Brgy Secret Lane", status: "spotted", sex }).returning();
    if (photo) {
      const key = newPublicKey();
      await getStorage().putPublic(key, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
      await db.insert(sightings).values({ catId: c.id, originalKey: "originals/x", publicKey: key, publicReady: true, state: "matched" });
    }
    return c;
  }

  it("gives public fields only: name, a same-origin photo address, palette names", async () => {
    const girl = await cat("Bituin", true, "female");
    await cat("Ningning");
    const data = (await getKeepsake(girl.id))!;
    expect(data.name).toBe("Bituin");
    expect(data.photo).toBe(`/api/cats/${girl.id}/keepsake/photo`);
    expect(data.hero).toEqual({ id: girl.id, avatar: expect.any(Object), female: true });
    expect(data.others).toHaveLength(1);
    expect(data.others[0].female).toBe(false);
    expect(Object.keys(data.others[0]).sort()).toEqual(["avatar", "female", "id"]);
    // The route hands over these keys and no others: the status label is the only addition for the status line.
    expect(Object.keys(data).sort()).toEqual(["box", "hero", "name", "others", "photo", "statusLabel"]);
    const text = JSON.stringify(data);
    expect(text).not.toContain("Secret Lane");
    expect(text).not.toMatch(/memory-photos|originals\//);
  });

  it("carries the same status label the cat card shows, for every status", async () => {
    const c = await cat("Labelled");
    for (const status of ["spotted", "queued", "funded", "booked", "in_care", "neutered", "adoptable", "adopted"]) {
      await db.update(cats).set({ status, neuteredUnconfirmed: false }).where(eq(cats.id, c.id));
      expect((await getKeepsake(c.id))!.statusLabel).toBe((await getCatCard(c.id))!.cat.statusLabel);
    }
    await db.update(cats).set({ status: "queued" }).where(eq(cats.id, c.id));
    expect((await getKeepsake(c.id))!.statusLabel).toBe("Waiting for funding");
    // Two neighbours saying so is not a neuter: the saved image says what the card says.
    await db.update(cats).set({ status: "neutered", neuteredUnconfirmed: true }).where(eq(cats.id, c.id));
    expect((await getKeepsake(c.id))!.statusLabel).toBe("Neighbours say already neutered");
    expect(JSON.stringify(await getKeepsake(c.id))).not.toMatch(/Brgy|Secret Lane/);
  });

  it("carries the stored box of the photo shown, and none for an older cat", async () => {
    const c = await cat("Boxed");
    await db.update(sightings).set({ catBox: { x: 0.2, y: 0.3, w: 0.4, h: 0.3 } });
    expect((await getKeepsake(c.id))!.box).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.3 });
    await db.update(sightings).set({ catBox: null });
    expect((await getKeepsake(c.id))!.box).toBeNull();
  });

  it("has nothing for a cat with no public photo, and a missing or malformed id", async () => {
    const bare = await cat("Bare", false);
    expect(await getKeepsake(bare.id)).toBeNull();
    expect((await dataGet(new Request("http://x"), ctx(bare.id))).status).toBe(404);
    expect((await dataGet(new Request("http://x"), ctx("nope"))).status).toBe(404);
    expect((await photoGet(new Request("http://x"), ctx("nope"))).status).toBe(404);
  });

  it("serves the data route openly, and never the private original", async () => {
    const c = await cat("Bituin");
    const res = await dataGet(new Request("http://x"), ctx(c.id));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Bituin");
  });
});
