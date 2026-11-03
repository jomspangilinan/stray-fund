import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NEUTRAL_AVATAR } from "../src/lib/avatar";
import { TAG_MAX, YARD_MAX, careMarks, phoneBoxes, placeAt, tagName, pickYard, slotFor, slotsFor, yardScale, yardSlots, yardStage, type YardCat } from "../src/lib/yard";
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
  marks: [], female: false,
});

describe("slots", () => {
  it("depends on the id only and is stable", () => {
    expect(slotFor("0f9a1c52-0000-4000-8000-000000000001")).toBe(slotFor("0f9a1c52-0000-4000-8000-000000000001"));
    expect(slotFor.length).toBe(1);
    for (let i = 0; i < 50; i++) {
      const s = slotFor(`cat-${i}`);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(YARD_MAX);
    }
  });

  it("spreads ids over the slots", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => slotFor(`id-${i}`)));
    expect(used.size).toBe(YARD_MAX);
  });

  it("gives every shown cat its own slot", () => {
    const ids = Array.from({ length: YARD_MAX }, (_, i) => `same-${i}`);
    const slots = slotsFor(ids);
    expect(new Set(slots.values()).size).toBe(YARD_MAX);
    // A cat keeps its preferred place when nobody else wants it, and a lone cat has the one place there is.
    expect(slotsFor(["solo"]).get("solo")).toBe(0);
    // The first cat in priority order always gets the place its id points to.
    expect(slots.get(ids[0])).toBe(slotFor(ids[0]));
  });

  it("keeps slot positions inside the yard, off the wall, for every count", () => {
    for (let n = 1; n <= YARD_MAX; n++) {
      const slots = yardSlots(n);
      expect(slots).toHaveLength(n);
      for (const s of slots) {
        expect(s.x).toBeGreaterThan(5);
        expect(s.x).toBeLessThan(95);
        expect(s.y).toBeGreaterThan(40);
        expect(s.y).toBeLessThan(95);
      }
    }
  });
});

describe("yard cat size", () => {
  it("is largest at 1 to 3, steady from 6 to today's size at 12, and shrinks smoothly between", () => {
    expect(yardScale(1)).toBe(yardScale(3));
    expect(yardScale(12)).toBe(1);
    expect(yardScale(3)).toBeGreaterThan(1.9);
    for (let n = 3; n < 12; n++) {
      const step = yardScale(n) - yardScale(n + 1);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(0.25);
    }
  });

  it("makes 1 to 3 cats 30 percent bigger than they were and leaves 6 and 12 as they were", () => {
    expect(yardScale(1)).toBeCloseTo(1.5 * 1.3, 10);
    expect(yardScale(6)).toBeCloseTo(1.5 - 0.5 * (3 / 9), 10);
  });

  it("keeps every cat inside the stage and clear of the others, with its tag, at every count from 1 to 12", () => {
    const overlap = (a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }) =>
      a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    for (let n = 1; n <= YARD_MAX; n++) {
      const scale = yardScale(n);
      const boxes = yardSlots(n).map((s) => phoneBoxes(s, scale));
      for (const [i, a] of boxes.entries()) {
        // Inside the stage, with room to stroll sideways.
        const p = placeAt(yardSlots(n)[i], scale);
        expect(p.x - p.w * 0.7).toBeGreaterThanOrEqual(-1e-9);
        expect(p.x + p.w * 0.7).toBeLessThanOrEqual(100 + 1e-9);
        expect(a.cat.t).toBeGreaterThan(70);
        expect(a.tag.b).toBeLessThanOrEqual(288);
        for (const [j, b] of boxes.entries()) {
          if (j <= i) continue;
          expect(overlap(a.cat, b.cat), `${n} cats: ${i} and ${j} overlap`).toBe(false);
          expect(overlap(a.tag, b.tag), `${n} cats: tags ${i} and ${j} overlap`).toBe(false);
        }
      }
    }
  });

  it("starts the 26 px name tag at the feet line and keeps it off every other cat's body, at every count", () => {
    for (let n = 1; n <= YARD_MAX; n++) {
      const scale = yardScale(n);
      const boxes = yardSlots(n).map((s) => phoneBoxes(s, scale));
      for (const [i, a] of boxes.entries()) {
        expect(a.tag.t).toBe(a.cat.b);
        expect(a.tag.b - a.tag.t).toBeCloseTo(26, 6);
        for (const [j, b] of boxes.entries())
          if (i !== j) expect(a.tag.l < b.cat.r && b.cat.l < a.tag.r && a.tag.t < b.cat.b && b.cat.t < a.tag.b, `${n} cats: tag ${i} covers cat ${j}`).toBe(false);
      }
    }
  });
});

describe("name tags", () => {
  it("cuts a long name to 30 characters with an ellipsis and leaves short ones alone", () => {
    expect(tagName("Muning")).toBe("Muning");
    expect(tagName("a".repeat(TAG_MAX))).toBe("a".repeat(TAG_MAX));
    const cut = tagName("Maria Clara Isabella Santos-Reyes de la Cruz");
    expect(Array.from(cut)).toHaveLength(TAG_MAX);
    expect(cut.endsWith("\u2026")).toBe(true);
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
    expect(Object.keys(yard.cats[0]).sort()).toEqual(["avatar", "female", "group", "id", "marks", "name", "statusLabel"]);
    expect(yard.cats[0]).toMatchObject({ name: "Mimi", group: "waiting", avatar: { pattern: "tabby", base: "ginger", accent: "brown" }, marks: ["collar"], female: false });
    const text = JSON.stringify(yard);
    for (const s of ["10.987654321", "120.123456789", "10.55555555", "120.66666666", "exact", "fuzzed", "secret-marking-sentinel", "bio-sentinel", "originals/", "orange"]) {
      expect(text, `leaked ${s}`).not.toContain(s);
    }
  });

  it("tells the yard only whether a cat is a girl: a yes or no, never the word or who said", async () => {
    await db.insert(cats).values([
      { name: "Gal", areaName: "x", sex: "female" },
      { name: "Guy", areaName: "x", sex: "male" },
      { name: "Who", areaName: "x" },
    ]);
    const yard = await getYard(null);
    const byName = Object.fromEntries(yard.cats.map((c) => [c.name, c.female]));
    expect(byName).toEqual({ Gal: true, Guy: false, Who: false });
    for (const c of yard.cats) expect(typeof c.female).toBe("boolean");
    expect(JSON.stringify(yard).toLowerCase()).not.toMatch(/"sex"|:"(fe)?male"/);
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
