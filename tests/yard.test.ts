import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NEUTRAL_AVATAR } from "../src/lib/avatar";
import { YARD_MAX, YARD_SLOTS, careMarks, pickYard, slotFor, slotsFor, yardStage, type YardCat } from "../src/lib/yard";
import { closePool, db } from "../src/server/db/client";
import { cats, sightings, treatments } from "../src/server/db/schema";
import { getYard } from "../src/server/public";
import { truncateAll } from "./helpers/db";

const cat = (id: string, group: YardCat["group"] = "neutered"): YardCat => ({
  id,
  name: id,
  group,
  statusLabel: group,
  avatar: NEUTRAL_AVATAR,
  marks: [],
});

describe("slots", () => {
  it("depends on the id only and is stable", () => {
    expect(slotFor("0f9a1c52-0000-4000-8000-000000000001")).toBe(slotFor("0f9a1c52-0000-4000-8000-000000000001"));
    expect(slotFor.length).toBe(1);
    for (let i = 0; i < 50; i++) {
      const s = slotFor(`cat-${i}`);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(YARD_SLOTS.length);
    }
  });

  it("spreads ids over the slots", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => slotFor(`id-${i}`)));
    expect(used.size).toBe(YARD_SLOTS.length);
  });

  it("gives every shown cat its own slot", () => {
    const ids = Array.from({ length: YARD_MAX }, (_, i) => `same-${i}`);
    const slots = slotsFor(ids);
    expect(new Set(slots.values()).size).toBe(YARD_MAX);
    // A cat keeps its preferred slot when nobody else wants it.
    expect(slotsFor(["solo"]).get("solo")).toBe(slotFor("solo"));
  });

  it("keeps slot positions inside the yard, off the wall", () => {
    for (const s of YARD_SLOTS) {
      expect(s.x).toBeGreaterThan(5);
      expect(s.x).toBeLessThan(95);
      expect(s.y).toBeGreaterThan(40);
      expect(s.y).toBeLessThan(95);
    }
  });
});

describe("yardStage", () => {
  it("grows from real counts and never goes backwards as the count rises", () => {
    expect(yardStage(0, 30)).toBe(0);
    expect(yardStage(2, 30)).toBe(0);
    expect(yardStage(3, 30)).toBe(1);
    expect(yardStage(12, 30)).toBe(2);
    expect(yardStage(23, 30)).toBe(3);
    expect(yardStage(30, 30)).toBe(3);
    expect(yardStage(99, 30)).toBe(3);
    let last = 0;
    for (let n = 0; n <= 40; n++) {
      const s = yardStage(n, 30);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it("is calm with nonsense input", () => {
    expect(yardStage(5, 0)).toBe(0);
    expect(yardStage(-3, 30)).toBe(0);
    expect(yardStage(Number.NaN, 30)).toBe(0);
  });
});

describe("pickYard", () => {
  it("shows at most the yard maximum", () => {
    const all = Array.from({ length: 30 }, (_, i) => cat(`c${i}`));
    expect(pickYard(all, new Set())).toHaveLength(YARD_MAX);
  });

  it("puts waiting cats and the viewer's helped cats first", () => {
    const all = [
      ...Array.from({ length: 14 }, (_, i) => cat(`n${i}`, "neutered")),
      cat("w1", "waiting"),
      cat("h1", "neutered"),
      cat("w2", "waiting"),
    ];
    const ids = pickYard(all, new Set(["h1"])).map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual(["w1", "w2", "h1"]);
    expect(ids).toHaveLength(YARD_MAX);
  });

  it("ranks a helped waiting cat above the rest of the waiting cats", () => {
    const all = [cat("w1", "waiting"), cat("w2", "waiting")];
    expect(pickYard(all, new Set(["w2"])).map((c) => c.id)).toEqual(["w2", "w1"]);
  });
});

describe("careMarks", () => {
  it("shows earned care only", () => {
    const j = (names: string[]) => ["Spotted", "Neutered", "Vaccinated", "Dewormed"].map((step) => ({ step, done: step === "Spotted" || names.includes(step) }));
    expect(careMarks(j([]))).toEqual([]);
    expect(careMarks(j(["Vaccinated"]))).toEqual(["collar"]);
    expect(careMarks(j(["Neutered"]))).toEqual(["tip"]);
    expect(careMarks(j(["Neutered", "Vaccinated"])).sort()).toEqual(["collar", "tip"]);
  });
});

describe("getYard whitelist", () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  it("carries name, status group, avatar and care marks only", async () => {
    const [c] = await db
      .insert(cats)
      .values({
        name: "Mimi",
        status: "queued",
        areaName: "Brgy. San Antonio, near the market",
        exactLat: 10.987654321,
        exactLng: 120.123456789,
        fuzzedLat: 10.55555555,
        fuzzedLng: 120.66666666,
        coat: { colors: ["orange"], markings: "secret-marking-sentinel" },
        coatPattern: "tabby",
        avatar: { pattern: "tabby", base: "ginger", accent: "brown" },
        bio: "bio-sentinel",
      })
      .returning();
    await db.insert(sightings).values({ catId: c.id, originalKey: "originals/secret.jpg", state: "new_cat" });
    await db.insert(treatments).values({ catId: c.id, type: "vaccine", date: "2026-10-01" });
    const yard = await getYard(null);
    expect(Object.keys(yard).sort()).toEqual(["cats", "goal", "stage", "total"]);
    expect(yard.cats).toHaveLength(1);
    expect(Object.keys(yard.cats[0]).sort()).toEqual(["avatar", "group", "id", "marks", "name", "statusLabel"]);
    expect(yard.cats[0]).toMatchObject({ name: "Mimi", group: "waiting", avatar: { pattern: "tabby", base: "ginger", accent: "brown" }, marks: ["collar"] });
    const text = JSON.stringify(yard);
    for (const s of ["10.987654321", "120.123456789", "10.55555555", "120.66666666", "exact", "fuzzed", "secret-marking-sentinel", "bio-sentinel", "originals/", "orange"]) {
      expect(text, `leaked ${s}`).not.toContain(s);
    }
  });

  it("uses the neutral cat until an avatar is ready and refuses a tampered one", async () => {
    await db.insert(cats).values([
      { name: "Plain", areaName: "x" },
      { name: "Bad", areaName: "x", avatar: { pattern: "tabby", base: "<script>", accent: "brown" } },
    ]);
    const yard = await getYard(null);
    expect(yard.cats).toHaveLength(2);
    for (const c of yard.cats) expect(c.avatar).toEqual(NEUTRAL_AVATAR);
  });

  it("says how many cats there are in total when the yard shows fewer", async () => {
    await db.insert(cats).values(Array.from({ length: YARD_MAX + 3 }, (_, i) => ({ name: `C${i}`, areaName: "x" })));
    const yard = await getYard(null);
    expect(yard.cats).toHaveLength(YARD_MAX);
    expect(yard.total).toBe(YARD_MAX + 3);
  });
});
