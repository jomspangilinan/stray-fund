import type { CatBox } from "./keepsake";
import { letterbox, decodeCat } from "./yoloSeg";

/** Runs the model on a letterboxed input and returns its two outputs (see yoloSeg.ts). */
export type SegRun = (input: Float32Array) => Promise<{ out0: Float32Array; out1: Float32Array }>;

/**
 * The pure core of the phone tier: letterbox, run, decode. Null when the model finds no cat, so the photo goes
 * to the server tier. The same letterbox and decodeCat the worker uses.
 */
export async function cutCat(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  run: SegRun,
): Promise<{ mask: Uint8Array; box: CatBox } | null> {
  const lb = letterbox(rgba, width, height);
  const { out0, out1 } = await run(lb.input);
  const found = decodeCat(out0, out1, lb, width, height);
  return found ? { mask: found.mask, box: found.box } : null;
}

/** Resolves with the work's value, or null once `ms` pass or the work fails. A late result is dropped. */
export function orNullAfter<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
