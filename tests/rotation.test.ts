import { describe, expect, it } from "vitest";
import { gravityFromMotion, rotateBox, turnBox, turnFromGravity } from "../src/lib/rotation";

// W3C sign convention: an upright portrait phone reads y = +9.8.
describe("turnFromGravity", () => {
  it("leaves an upright phone alone", () => {
    expect(turnFromGravity({ x: 0, y: 9.8 }, 0)).toBe(0);
  });
  it("turns a sideways phone with rotation lock", () => {
    expect(turnFromGravity({ x: -9.8, y: 0 }, 0)).toBe(90);
    expect(turnFromGravity({ x: 9.8, y: 0 }, 0)).toBe(270);
  });
  it("never turns 180, so a wrong iOS sign cannot flip every normal photo", () => {
    expect(turnFromGravity({ x: 0, y: -9.8 }, 0)).toBe(0);
    expect(turnFromGravity({ x: 0, y: 9.8 }, 180)).toBe(0);
  });
  it("needs no turn when the page rotated with the phone", () => {
    expect(turnFromGravity({ x: 9.8, y: 0 }, 90)).toBe(0);
    expect(turnFromGravity({ x: -9.8, y: 0 }, 270)).toBe(0);
    expect(turnFromGravity({ x: 0, y: -9.8 }, 180)).toBe(0);
  });
  it("keeps the nearer side within 25 degrees of a diagonal", () => {
    const tilt = (deg: number) => ({ x: -9.8 * Math.sin((deg * Math.PI) / 180), y: 9.8 * Math.cos((deg * Math.PI) / 180) });
    expect(turnFromGravity(tilt(40), 0)).toBe(0);
    expect(turnFromGravity(tilt(50), 0)).toBe(90);
    expect(turnFromGravity(tilt(-40), 0)).toBe(0);
    expect(turnFromGravity(tilt(-50), 0)).toBe(270);
  });
  it("says 0 for a phone lying flat", () => {
    expect(turnFromGravity({ x: 0.3, y: -0.2 }, 0)).toBe(0);
  });
});

describe("gravityFromMotion", () => {
  it("flips the sign on iOS and passes Android through", () => {
    expect(gravityFromMotion({ x: 1, y: -9.8 }, true)).toEqual({ x: -1, y: 9.8 });
    expect(gravityFromMotion({ x: 1, y: 9.8 }, false)).toEqual({ x: 1, y: 9.8 });
    expect(gravityFromMotion({ x: null, y: 9.8 }, false)).toBeNull();
  });
});

describe("turnBox", () => {
  const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const close = (a: typeof b, e: typeof b) => {
    for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(e[k]);
  };
  it("moves the box with the photo", () => {
    close(turnBox(b, 0), b);
    close(turnBox(b, 90), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
    close(turnBox(b, 180), { x: 0.6, y: 0.4, w: 0.3, h: 0.4 });
    close(turnBox(b, 270), { x: 0.2, y: 0.6, w: 0.4, h: 0.3 });
  });
  it("is undone by the opposite turns", () => {
    close(turnBox(turnBox(b, 90), 270), b);
    close(turnBox(turnBox(b, 180), 180), b);
  });
});

describe("rotateBox", () => {
  it("turns a box a quarter clockwise, and four turns return it", () => {
    const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const r = rotateBox(b, 90);
    expect(r.x).toBeCloseTo(0.4);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.w).toBeCloseTo(0.4);
    expect(r.h).toBeCloseTo(0.3);
    let back = b;
    for (let i = 0; i < 4; i++) back = rotateBox(back, 90);
    expect(back.x).toBeCloseTo(b.x);
    expect(back.y).toBeCloseTo(b.y);
    expect(back.w).toBeCloseTo(b.w);
    expect(back.h).toBeCloseTo(b.h);
  });
});
