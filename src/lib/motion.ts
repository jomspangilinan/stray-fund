/** Fraction of pixels that must change for a frame to count as motion. */
export const MOTION_THRESHOLD = 0.08;
/** Minimum time between captures, measured from the last capture. */
export const COOLDOWN_MS = 30_000;
/** A pixel counts as changed only when its luminance moves by more than this (0 to 255). */
export const PIXEL_NOISE = 24;

function luma(d: Uint8ClampedArray, i: number): number {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/**
 * Fraction (0 to 1) of pixels whose luminance changed by more than PIXEL_NOISE.
 * Small per-pixel jitter from the sensor on a static scene therefore reads as 0.
 */
export function frameDiff(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("Frames must have the same dimensions");
  }
  const n = a.width * a.height;
  if (n === 0) return 0;
  let changed = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (Math.abs(luma(a.data, i) - luma(b.data, i)) > PIXEL_NOISE) changed++;
  }
  return changed / n;
}

export function shouldCapture(i: {
  diff: number;
  lastCaptureAt: number | null;
  now: number;
  inFlight?: boolean;
}): boolean {
  if (i.inFlight) return false;
  if (i.diff <= MOTION_THRESHOLD) return false;
  if (i.lastCaptureAt !== null && i.now - i.lastCaptureAt < COOLDOWN_MS) return false;
  return true;
}
