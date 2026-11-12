import type { CatBox } from "./keepsake";
import { frameMask, type Fit } from "./catMask";

/*
 * Before and after the YOLO11n-seg model (public/models/cat-seg-v1). Pure, so the phone and the worker run
 * the same code around the same model file. The model takes one 640x640 RGB picture and gives
 * output0 [1, 116, 8400] (per candidate: a box, 80 class scores and 32 mask weights, stored channel first)
 * and output1 [1, 32, 160, 160] (the mask prototypes).
 */

/** COCO's class index for a cat. */
export const CAT_CLASS = 15;
/** A candidate is a cat from this class score up. */
export const CAT_MIN_SCORE = 0.35;
export const INPUT_SIDE = 640;
const CANDIDATES = 8400;
const CLASSES = 80;
const COEFFS = 32;
const PROTO_SIDE = 160;
const PAD = 114 / 255;

/**
 * Fits the frame inside 640x640 keeping its shape, centred on grey (114) padding, as the model was trained.
 * Returns the input as planar RGB scaled to 0..1, and the fit to undo afterwards.
 */
export function letterbox(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { input: Float32Array; scale: number; padX: number; padY: number } {
  const plane = INPUT_SIDE * INPUT_SIDE;
  const input = new Float32Array(3 * plane).fill(PAD);
  const scale = Math.min(INPUT_SIDE / width, INPUT_SIDE / height);
  const w = Math.min(INPUT_SIDE, Math.max(1, Math.round(width * scale)));
  const h = Math.min(INPUT_SIDE, Math.max(1, Math.round(height * scale)));
  const padX = Math.floor((INPUT_SIDE - w) / 2);
  const padY = Math.floor((INPUT_SIDE - h) / 2);
  const px = (x: number, y: number, c: number) => rgba[(y * width + x) * 4 + c];
  for (let oy = 0; oy < h; oy++) {
    const sy = Math.min(height - 1, Math.max(0, ((oy + 0.5) * height) / h - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let ox = 0; ox < w; ox++) {
      const sx = Math.min(width - 1, Math.max(0, ((ox + 0.5) * width) / w - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const o = (oy + padY) * INPUT_SIDE + ox + padX;
      for (let c = 0; c < 3; c++) {
        const top = px(x0, y0, c) * (1 - fx) + px(x1, y0, c) * fx;
        const bottom = px(x0, y1, c) * (1 - fx) + px(x1, y1, c) * fx;
        input[c * plane + o] = (top * (1 - fy) + bottom * fy) / 255;
      }
    }
  }
  return { input, scale, padX, padY };
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The most likely cat in the model's output: its box as fractions of the frame and its cut-out
 * (MASK_SIDE x MASK_SIDE, 0 or 255) over the whole frame. Null when no candidate scores CAT_MIN_SCORE as a cat.
 * One best cat is all a sighting needs, so there is no non-maximum suppression.
 */
export function decodeCat(
  out0: Float32Array,
  out1: Float32Array,
  lb: Fit,
  width: number,
  height: number,
): { box: CatBox; mask: Uint8Array } | null {
  const scoreAt = (4 + CAT_CLASS) * CANDIDATES;
  let best = -1;
  let bestScore = CAT_MIN_SCORE;
  for (let a = 0; a < CANDIDATES; a++) {
    const s = out0[scoreAt + a];
    if (s >= bestScore && (best < 0 || s > bestScore)) {
      best = a;
      bestScore = s;
    }
  }
  if (best < 0) return null;

  const [cx, cy, bw, bh] = [0, 1, 2, 3].map((c) => out0[c * CANDIDATES + best]);
  const inputBox = { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
  const fx0 = clamp01((inputBox.x0 - lb.padX) / lb.scale / width);
  const fy0 = clamp01((inputBox.y0 - lb.padY) / lb.scale / height);
  const fx1 = clamp01((inputBox.x1 - lb.padX) / lb.scale / width);
  const fy1 = clamp01((inputBox.y1 - lb.padY) / lb.scale / height);
  if (!(fx1 > fx0) || !(fy1 > fy0)) return null;

  const coeffs = new Float32Array(COEFFS);
  for (let k = 0; k < COEFFS; k++) coeffs[k] = out0[(4 + CLASSES + k) * CANDIDATES + best];
  const cells = PROTO_SIDE * PROTO_SIDE;
  const prob = new Float32Array(cells);
  for (let k = 0; k < COEFFS; k++) {
    const c = coeffs[k];
    if (c === 0) continue;
    const base = k * cells;
    for (let p = 0; p < cells; p++) prob[p] += c * out1[base + p];
  }
  for (let p = 0; p < cells; p++) prob[p] = sigmoid(prob[p]);

  const mask = frameMask(prob, PROTO_SIDE, INPUT_SIDE, lb, inputBox, width, height);
  return { box: { x: fx0, y: fy0, w: fx1 - fx0, h: fy1 - fy0 }, mask };
}
