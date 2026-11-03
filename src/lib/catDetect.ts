/*
 * Pure logic for the on-device "cat found" hint. It never decides anything: it only steadies a label.
 * The server's check stays the authority, and the shutter is never blocked by anything here.
 */

export type Prediction = { class: string; score: number; bbox: [number, number, number, number] };
export type Box = { x: number; y: number; w: number; h: number };
export type CatBox = Box & { score: number };

/**
 * True when the 18 MB model should not be fetched: data saver is on, or the connection is slow.
 * Missing connection info means load as before.
 */
export function skipDetector(c: { saveData?: boolean; effectiveType?: string } | undefined | null): boolean {
  if (!c) return false;
  return c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g" || c.effectiveType === "3g";
}

export const MIN_SCORE = 0.5;
/** Below this many frames a second the hint switches itself off. */
export const MIN_FPS = 5;
/** The model gets this long to load before the hint switches itself off. */
export const LOAD_LIMIT_MS = 8000;
const HITS_TO_LOCK = 2;
const MISSES_TO_RELEASE = 4;
const SAMPLE = 6;

export function pickCat(preds: Prediction[]): CatBox | null {
  let best: Prediction | null = null;
  for (const q of preds) if (q.class === "cat" && q.score >= MIN_SCORE && (!best || q.score > best.score)) best = q;
  return best ? { x: best.bbox[0], y: best.bbox[1], w: best.bbox[2], h: best.bbox[3], score: best.score } : null;
}

export type LockState = "looking" | "found";

/** Two hits to lock on, four misses in a row to let go, so the label does not flicker. */
export function createLock() {
  let hits = 0;
  let misses = 0;
  const lock = {
    state: "looking" as LockState,
    box: null as CatBox | null,
    update(box: CatBox | null): LockState {
      if (box) {
        hits++;
        misses = 0;
        if (hits >= HITS_TO_LOCK) {
          lock.state = "found";
          lock.box = box;
        }
      } else {
        hits = 0;
        misses++;
        if (lock.state === "found" && misses >= MISSES_TO_RELEASE) {
          lock.state = "looking";
          lock.box = null;
        }
      }
      return lock.state;
    },
  };
  return lock;
}

/** Milliseconds per recent frame. True when the last frames ran under the minimum rate. */
export function tooSlow(frameMs: number[]): boolean {
  if (frameMs.length < SAMPLE) return false;
  const recent = frameMs.slice(-SAMPLE);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return 1000 / avg < MIN_FPS;
}

/** Where a box in video pixels lands in a view that shows the video cropped to cover it. */
export function boxToView(box: Box, video: { w: number; h: number }, view: { w: number; h: number }): Box {
  const scale = Math.max(view.w / video.w, view.h / video.h);
  const offX = (video.w * scale - view.w) / 2;
  const offY = (video.h * scale - view.h) / 2;
  return { x: box.x * scale - offX, y: box.y * scale - offY, w: box.w * scale, h: box.h * scale };
}

/** Keeps a box inside a safe rectangle, so the brackets never hide under the bars. */
export function clampBox(b: Box, safe: Box): Box {
  const x = Math.min(Math.max(b.x, safe.x), safe.x + safe.w);
  const y = Math.min(Math.max(b.y, safe.y), safe.y + safe.h);
  const r = Math.min(b.x + b.w, safe.x + safe.w);
  const bt = Math.min(b.y + b.h, safe.y + safe.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) };
}
