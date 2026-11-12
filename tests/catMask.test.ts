import { describe, expect, it } from "vitest";
import { MASK_SIDE } from "../src/lib/catMask";
import { MASK_SIDE as SERVER_MASK_SIDE } from "../src/server/photos";
import { CAT_CLASS, CAT_MIN_SCORE, decodeCat, letterbox } from "../src/lib/yoloSeg";

const N = 8400;
const PROTO = 160;

type Candidate = { cx: number; cy: number; w: number; h: number; cls?: number; score: number };

/** output0 as the model lays it out, channel first: [116][8400]. Mask weight 0 is 1 for every candidate. */
function out0Of(cands: Candidate[]): Float32Array {
  const out = new Float32Array(116 * N);
  cands.forEach((c, a) => {
    out[0 * N + a] = c.cx;
    out[1 * N + a] = c.cy;
    out[2 * N + a] = c.w;
    out[3 * N + a] = c.h;
    out[(4 + (c.cls ?? CAT_CLASS)) * N + a] = c.score;
    out[84 * N + a] = 1;
  });
  return out;
}

/** output1 with prototype 0 strongly positive left of input x = `edge` and strongly negative right of it. */
function out1LeftOf(edge: number): Float32Array {
  const out = new Float32Array(32 * PROTO * PROTO);
  for (let y = 0; y < PROTO; y++) for (let x = 0; x < PROTO; x++) out[y * PROTO + x] = (x + 0.5) * 4 < edge ? 10 : -10;
  return out;
}

const halves = (mask: Uint8Array) => {
  const left = new Set<number>();
  const right = new Set<number>();
  for (let y = 0; y < MASK_SIDE; y++)
    for (let x = 0; x < MASK_SIDE; x++) (x < MASK_SIDE / 2 ? left : right).add(mask[y * MASK_SIDE + x]);
  return { left: [...left], right: [...right] };
};

describe("decodeCat", () => {
  it("finds the cat over the left half of a square frame, box and cut-out", () => {
    const out0 = out0Of([{ cx: 160, cy: 320, w: 320, h: 640, score: 0.9 }]);
    const found = decodeCat(out0, out1LeftOf(320), { scale: 1, padX: 0, padY: 0 }, 640, 640);
    expect(found).not.toBeNull();
    const { box, mask } = found!;
    expect(box.x).toBeCloseTo(0, 5);
    expect(box.y).toBeCloseTo(0, 5);
    expect(box.w).toBeCloseTo(0.5, 5);
    expect(box.h).toBeCloseTo(1, 5);
    expect(mask).toHaveLength(64 * 64);
    expect(halves(mask)).toEqual({ left: [255], right: [0] });
  });

  it("keeps the cut-out inside the box even where the prototypes say cat", () => {
    // The mask is positive over the whole frame, the box covers the left half only.
    const out0 = out0Of([{ cx: 160, cy: 320, w: 320, h: 640, score: 0.9 }]);
    const found = decodeCat(out0, out1LeftOf(9999), { scale: 1, padX: 0, padY: 0 }, 640, 640);
    expect(halves(found!.mask)).toEqual({ left: [255], right: [0] });
  });

  it("is null when the best cat scores under the minimum, whatever the other classes say", () => {
    const out0 = out0Of([
      { cx: 160, cy: 320, w: 320, h: 640, score: 0.2 },
      { cx: 400, cy: 320, w: 200, h: 200, cls: 16, score: 0.95 },
    ]);
    expect(CAT_MIN_SCORE).toBe(0.35);
    expect(decodeCat(out0, out1LeftOf(320), { scale: 1, padX: 0, padY: 0 }, 640, 640)).toBeNull();
  });

  it("picks the highest scoring cat", () => {
    const out0 = out0Of([
      { cx: 480, cy: 320, w: 320, h: 640, score: 0.5 },
      { cx: 160, cy: 320, w: 320, h: 640, score: 0.9 },
      { cx: 320, cy: 320, w: 100, h: 100, score: 0.4 },
    ]);
    const { box } = decodeCat(out0, out1LeftOf(320), { scale: 1, padX: 0, padY: 0 }, 640, 640)!;
    expect(box.x).toBeCloseTo(0, 5);
    expect(box.w).toBeCloseTo(0.5, 5);
  });

  it("undoes the top and bottom padding of a landscape frame", () => {
    // 1280x720 sits in the input at scale 0.5, rows 140 to 500.
    const out0 = out0Of([{ cx: 160, cy: 320, w: 320, h: 360, score: 0.9 }]);
    const { box, mask } = decodeCat(out0, out1LeftOf(320), { scale: 0.5, padX: 0, padY: 140 }, 1280, 720)!;
    expect(box.x).toBeCloseTo(0, 5);
    expect(box.y).toBeCloseTo(0, 5);
    expect(box.w).toBeCloseTo(0.5, 5);
    expect(box.h).toBeCloseTo(1, 5);
    expect(halves(mask)).toEqual({ left: [255], right: [0] });
  });

  it("undoes the side padding of a portrait frame", () => {
    // 720x1280 sits in the input at scale 0.5, columns 140 to 500. The box is the frame's top-left quarter.
    const out0 = out0Of([{ cx: 230, cy: 160, w: 180, h: 320, score: 0.9 }]);
    const { box, mask } = decodeCat(out0, out1LeftOf(9999), { scale: 0.5, padX: 140, padY: 0 }, 720, 1280)!;
    expect(box.x).toBeCloseTo(0, 5);
    expect(box.y).toBeCloseTo(0, 5);
    expect(box.w).toBeCloseTo(0.5, 5);
    expect(box.h).toBeCloseTo(0.5, 5);
    const at = (x: number, y: number) => mask[y * MASK_SIDE + x];
    expect([at(10, 10), at(31, 31)]).toEqual([255, 255]);
    expect([at(40, 10), at(10, 40), at(40, 40)]).toEqual([0, 0, 0]);
  });

  it("clamps a box that runs off the frame into frame fractions", () => {
    const out0 = out0Of([{ cx: 0, cy: 320, w: 320, h: 900, score: 0.9 }]);
    const { box } = decodeCat(out0, out1LeftOf(320), { scale: 1, padX: 0, padY: 0 }, 640, 640)!;
    expect(box).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
  });
});

describe("letterbox", () => {
  it("fits a 1280x720 frame at half size, centred between grey bands", () => {
    const rgba = new Uint8ClampedArray(1280 * 720 * 4);
    for (let i = 0; i < 1280 * 720; i++) rgba.set([200, 100, 50, 255], i * 4);
    const lb = letterbox(rgba, 1280, 720);
    expect(lb.scale).toBe(0.5);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(140);
    expect(lb.input).toHaveLength(3 * 640 * 640);
    const plane = 640 * 640;
    const at = (c: number, x: number, y: number) => lb.input[c * plane + y * 640 + x];
    // Padding above and below, the picture in between, RGB planes in order.
    expect(at(0, 0, 0)).toBeCloseTo(114 / 255, 6);
    expect(at(2, 639, 639)).toBeCloseTo(114 / 255, 6);
    expect(at(0, 320, 139)).toBeCloseTo(114 / 255, 6);
    expect([at(0, 320, 140), at(1, 320, 320), at(2, 320, 499)].map((v) => Math.round(v * 255))).toEqual([200, 100, 50]);
    expect(at(0, 320, 500)).toBeCloseTo(114 / 255, 6);
  });

  it("enlarges a small frame to fill the input", () => {
    const lb = letterbox(new Uint8Array(320 * 320 * 4), 320, 320);
    expect(lb).toMatchObject({ scale: 2, padX: 0, padY: 0 });
  });
});

it("the cut-out size is the one the server checks", () => {
  expect(MASK_SIDE).toBe(64);
  expect(SERVER_MASK_SIDE).toBe(MASK_SIDE);
});
