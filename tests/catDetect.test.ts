import { describe, expect, it } from "vitest";
import {
  MIN_FPS,
  LOAD_LIMIT_MS,
  createLock,
  pickCat,
  tooSlow,
  boxToView,
  type Prediction,
} from "../src/lib/catDetect";

const p = (cls: string, score: number, bbox: [number, number, number, number] = [10, 10, 100, 100]): Prediction => ({
  class: cls,
  score,
  bbox,
});

describe("pickCat", () => {
  it("returns the best cat above the threshold and ignores other animals", () => {
    expect(pickCat([p("dog", 0.99), p("cat", 0.6, [1, 2, 3, 4]), p("cat", 0.8, [5, 6, 7, 8])])).toEqual({
      x: 5,
      y: 6,
      w: 7,
      h: 8,
      score: 0.8,
    });
    expect(pickCat([p("dog", 0.99)])).toBeNull();
    expect(pickCat([p("cat", 0.2)])).toBeNull();
    expect(pickCat([])).toBeNull();
  });
});

describe("createLock", () => {
  const box = { x: 0, y: 0, w: 10, h: 10, score: 0.9 };
  it("starts looking, and needs two hits in a row to say found", () => {
    const l = createLock();
    expect(l.state).toBe("looking");
    expect(l.update(box)).toBe("looking");
    expect(l.update(box)).toBe("found");
  });

  it("does not flicker: a single miss keeps the lock, four in a row release it", () => {
    const l = createLock();
    l.update(box);
    l.update(box);
    for (let i = 0; i < 3; i++) expect(l.update(null)).toBe("found");
    expect(l.update(null)).toBe("looking");
  });

  it("a hit between misses resets the miss count", () => {
    const l = createLock();
    l.update(box);
    l.update(box);
    l.update(null);
    l.update(null);
    l.update(box);
    for (let i = 0; i < 3; i++) expect(l.update(null)).toBe("found");
  });

  it("keeps the last box while found", () => {
    const l = createLock();
    l.update(box);
    l.update(box);
    expect(l.box).toEqual(box);
    l.update(null);
    expect(l.box).toEqual(box);
  });
});

describe("tooSlow", () => {
  it("is false until enough frames are measured", () => {
    expect(tooSlow([1000, 1000])).toBe(false);
  });
  it("is true under the minimum frame rate", () => {
    expect(MIN_FPS).toBe(5);
    expect(tooSlow(Array(6).fill(260))).toBe(true);
  });
  it("is false at a healthy rate, and judges the recent frames", () => {
    expect(tooSlow(Array(6).fill(120))).toBe(false);
    expect(tooSlow([900, 900, 900, ...Array(6).fill(100)])).toBe(false);
  });
  it("gives the model 8 seconds to load", () => {
    expect(LOAD_LIMIT_MS).toBe(8000);
  });
});

describe("boxToView", () => {
  it("maps a video box to a cover-fitted view", () => {
    // 640x480 video shown in a 300x600 portrait view: scale 1.25, cropped sideways.
    const r = boxToView({ x: 320, y: 240, w: 64, h: 48 }, { w: 640, h: 480 }, { w: 300, h: 600 });
    expect(r.w).toBeCloseTo(80);
    expect(r.h).toBeCloseTo(60);
    expect(r.x).toBeCloseTo(320 * 1.25 - 250);
    expect(r.y).toBeCloseTo(240 * 1.25);
  });
  it("is the identity at the same size", () => {
    expect(boxToView({ x: 1, y: 2, w: 3, h: 4 }, { w: 100, h: 100 }, { w: 100, h: 100 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

import { clampBox } from "../src/lib/catDetect";
describe("clampBox", () => {
  const safe = { x: 10, y: 60, w: 300, h: 400 };
  it("keeps a box that fits", () => {
    expect(clampBox({ x: 50, y: 100, w: 100, h: 100 }, safe)).toEqual({ x: 50, y: 100, w: 100, h: 100 });
  });
  it("trims a box that spills past every edge", () => {
    expect(clampBox({ x: -20, y: 0, w: 500, h: 900 }, safe)).toEqual(safe);
  });
  it("never goes negative for a box fully outside", () => {
    const r = clampBox({ x: 900, y: 900, w: 10, h: 10 }, safe);
    expect(r.w).toBe(0);
    expect(r.h).toBe(0);
  });
});
