import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { YardScene } from "../src/components/YardScene";

describe("the courtyard drawing", () => {
  it("draws exactly what it drew before the wide yard, at every stage", async () => {
    for (const stage of [0, 1, 2, 3] as const) {
      await expect(renderToStaticMarkup(createElement(YardScene, { stage }))).toMatchFileSnapshot(`./__snapshots__/yard-scene-stage-${stage}.svg`);
    }
  });
});

import { YARD_SECTION, ZOOM_LEVELS, screenOf, screensAt, screensToDraw, sectionScale, yardScale, yardSections } from "../src/lib/yard";

describe("the wide yard", () => {
  it("holds ten cats a section, every cat exactly once, in the yard's order", () => {
    expect(YARD_SECTION).toBe(10);
    const ids = Array.from({ length: 103 }, (_, i) => `c${i}`);
    const parts = yardSections(ids);
    expect(parts).toHaveLength(11);
    expect(parts.slice(0, 10).every((p) => p.length === 10)).toBe(true);
    expect(parts[10]).toHaveLength(3);
    expect(parts.flat()).toEqual(ids);
    expect(yardSections([])).toEqual([[]]);
  });

  it("zooms from one section to 2 x 2 to 3 x 3, keeping the same cats in view", () => {
    expect([...ZOOM_LEVELS]).toEqual([1, 2, 3]);
    expect(screensAt(11, 1)).toBe(11);
    expect(screensAt(11, 2)).toBe(3);
    expect(screensAt(11, 3)).toBe(2);
    // Section 7 is on screen 7 zoomed in, screen 1 at 2 x 2 (sections 4 to 7), screen 0 at 3 x 3 (sections 0 to 8).
    expect(screenOf(7, 1)).toBe(7);
    expect(screenOf(7, 2)).toBe(1);
    expect(screenOf(7, 3)).toBe(0);
  });

  it("draws only the screen on show and its neighbours", () => {
    expect(screensToDraw(0, 11)).toEqual([0, 1]);
    expect(screensToDraw(5, 11)).toEqual([4, 5, 6]);
    expect(screensToDraw(10, 11)).toEqual([9, 10]);
    expect(screensToDraw(0, 1)).toEqual([0]);
  });

  it("draws cats at one size across sections, and today's sizes in a yard of one section", () => {
    expect(sectionScale(1, 3)).toBe(yardScale(3));
    expect(sectionScale(1, 10)).toBe(yardScale(10));
    expect(sectionScale(4, 2)).toBe(yardScale(10));
    expect(sectionScale(4, 10)).toBe(yardScale(10));
  });
});

import { DEFAULT_LOOK, sectionLook } from "../src/lib/yardLook";

describe("each section's look", () => {
  it("starts with today's courtyard, so the first screen is unchanged", () => {
    expect(sectionLook(0)).toEqual(DEFAULT_LOOK);
  });

  it("never repeats a wall, a window or a plant between neighbours, and only repeats as a whole after twelve", () => {
    for (let k = 0; k < 40; k++) {
      const a = sectionLook(k);
      const b = sectionLook(k + 1);
      expect(a.wall).not.toBe(b.wall);
      expect(a.windows).not.toBe(b.windows);
      expect(a.plant).not.toBe(b.plant);
    }
    const twelve = new Set(Array.from({ length: 12 }, (_, k) => JSON.stringify(sectionLook(k))));
    expect(twelve.size).toBe(12);
    expect(sectionLook(12)).toEqual(sectionLook(0));
  });
});
