import { FUR, type Avatar, type FurKey } from "./avatar";

/*
 * A cat's colours, read from a 16x16 shrink of its photo. Pure: no sharp, no DOM, so the phone can run it too.
 * Each pixel goes to its nearest palette colour by RGB distance; the commonest is the base, and the second
 * is the accent when it covers a sixth or so of the cat, otherwise the cat is one colour.
 */

/** The second colour counts only when it covers at least this share of the pixels. */
export const ACCENT_SHARE = 0.15;

const KEYS = Object.keys(FUR) as FurKey[];
const RGB: [number, number, number][] = KEYS.map((k) => {
  const n = parseInt(FUR[k].slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

function nearest(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < RGB.length; i++) {
    const d = (r - RGB[i][0]) ** 2 + (g - RGB[i][1]) ** 2 + (b - RGB[i][2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The avatar for a 16x16 RGBA image. Ties go to the colour listed first in FUR, so the same photo gives the same cat. */
export function avatarFromPixels(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Avatar {
  const counts = new Array<number>(KEYS.length).fill(0);
  let seen = 0;
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    if (rgba[o + 3] < 128) continue;
    counts[nearest(rgba[o], rgba[o + 1], rgba[o + 2])]++;
    seen++;
  }
  const order = counts.map((n, i) => ({ n, i })).sort((a, b) => b.n - a.n || a.i - b.i);
  const base = KEYS[order[0].i];
  const accent = seen > 0 && order[1].n / seen >= ACCENT_SHARE ? KEYS[order[1].i] : base;
  const pattern = base === accent ? "solid" : (base === "black" && accent === "white") || (base === "white" && accent === "black") ? "tuxedo" : "bicolour";
  return { pattern, base, accent };
}
