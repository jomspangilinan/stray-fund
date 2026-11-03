import { describe, expect, it } from "vitest";
import { COOLDOWN_MS, MOTION_THRESHOLD, frameDiff, shouldCapture } from "../src/lib/motion";

function frame(w: number, h: number, fill: (i: number) => number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = fill(i);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, colorSpace: "srgb" } as ImageData;
}

describe("frameDiff", () => {
  it("is 0 for identical frames", () => {
    const a = frame(40, 30, (i) => (i * 7) % 256);
    expect(frameDiff(a, frame(40, 30, (i) => (i * 7) % 256))).toBe(0);
  });

  it("exceeds the threshold when a large region changes", () => {
    const a = frame(40, 30, () => 40);
    const b = frame(40, 30, (i) => (i % 40 < 20 ? 220 : 40));
    expect(frameDiff(a, b)).toBeGreaterThan(MOTION_THRESHOLD);
  });

  it("stays under the threshold for small sensor jitter", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const a = frame(160, 120, () => 120);
    const b = frame(160, 120, () => 120 + Math.round((rnd() - 0.5) * 12));
    expect(frameDiff(a, b)).toBeLessThan(MOTION_THRESHOLD);
  });

  it("throws on mismatched dimensions", () => {
    expect(() => frameDiff(frame(10, 10, () => 0), frame(10, 12, () => 0))).toThrow();
  });
});

describe("shouldCapture", () => {
  const now = 1_000_000;
  it("needs motion above the threshold", () => {
    expect(shouldCapture({ diff: 0.05, lastCaptureAt: null, now })).toBe(false);
    expect(shouldCapture({ diff: MOTION_THRESHOLD, lastCaptureAt: null, now })).toBe(false);
    expect(shouldCapture({ diff: 0.2, lastCaptureAt: null, now })).toBe(true);
  });
  it("blocks inside the cooldown and allows exactly at 30 seconds", () => {
    expect(COOLDOWN_MS).toBe(30_000);
    expect(shouldCapture({ diff: 0.5, lastCaptureAt: now - 29_999, now })).toBe(false);
    expect(shouldCapture({ diff: 0.5, lastCaptureAt: now - 30_000, now })).toBe(true);
  });
  it("blocks while an upload is in flight", () => {
    expect(shouldCapture({ diff: 0.5, lastCaptureAt: null, now, inFlight: true })).toBe(false);
  });
});
