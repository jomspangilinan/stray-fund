import { describe, expect, it } from "vitest";
import { PHONE_CUT_TIMEOUT_MS, phoneCutAllowed } from "@/lib/catMask";
import { cutCat, orNullAfter, type SegRun } from "@/lib/phoneCut";

const ok = { connection: { saveData: false, effectiveType: "4g" }, loadedWithinLimit: true, fps: 12 };

describe("phoneCutAllowed", () => {
  it("allows a fast connection, a loaded model and a good frame rate", () => {
    expect(phoneCutAllowed(ok)).toBe(true);
    expect(phoneCutAllowed({ ...ok, connection: null })).toBe(true);
  });
  it("skips on data saver, 3g, a late model or a slow frame rate", () => {
    expect(phoneCutAllowed({ ...ok, connection: { saveData: true } })).toBe(false);
    expect(phoneCutAllowed({ ...ok, connection: { effectiveType: "3g" } })).toBe(false);
    expect(phoneCutAllowed({ ...ok, loadedWithinLimit: false })).toBe(false);
    expect(phoneCutAllowed({ ...ok, fps: 4 })).toBe(false);
  });
  it("has the 2.5 s limit", () => expect(PHONE_CUT_TIMEOUT_MS).toBe(2500));
});

const CANDIDATES = 8400;
const frame = (w: number, h: number) => new Uint8ClampedArray(w * h * 4).fill(128);

describe("cutCat", () => {
  it("is null when the model finds no cat, so the photo goes to the server tier", async () => {
    const run: SegRun = async () => ({ out0: new Float32Array(116 * CANDIDATES), out1: new Float32Array(32 * 160 * 160) });
    expect(await cutCat(frame(40, 30), 40, 30, run)).toBeNull();
  });
  it("gives a box and a 64x64 mask for a cat", async () => {
    const run: SegRun = async () => {
      const out0 = new Float32Array(116 * CANDIDATES);
      const a = 7;
      [320, 320, 400, 400].forEach((v, c) => (out0[c * CANDIDATES + a] = v));
      out0[(4 + 15) * CANDIDATES + a] = 0.9;
      out0[(4 + 80) * CANDIDATES + a] = 10; // coefficient 0
      const out1 = new Float32Array(32 * 160 * 160).fill(1); // prototype 0 all positive
      return { out0, out1 };
    };
    const found = await cutCat(frame(64, 64), 64, 64, run);
    expect(found).not.toBeNull();
    expect(found!.mask.length).toBe(64 * 64);
    expect(found!.mask.some((v) => v === 255)).toBe(true);
    expect(found!.box.w).toBeGreaterThan(0.5);
  });
});

describe("orNullAfter", () => {
  it("gives the value when it is in time", async () => {
    expect(await orNullAfter(Promise.resolve(5), 50)).toBe(5);
  });
  it("gives null when the work is too slow or fails", async () => {
    expect(await orNullAfter(new Promise<number>((r) => setTimeout(() => r(1), 200)), 20)).toBeNull();
    expect(await orNullAfter(Promise.reject(new Error("x")), 50)).toBeNull();
  });
});
