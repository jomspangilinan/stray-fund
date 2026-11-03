import { FUR, type FurKey } from "./avatar";

/*
 * The ground a cat stands on, and what keeps a cat visible on it. One set of values, read by the yard, the
 * reveal strip and the saved image, so a coat that stands out in one stands out in all.
 */
export const COURT = {
  wall: "#7fb2b4",
  wallDeep: "#5f969b",
  floor: "#9a8670",
  stone: "#8c7963",
} as const;

/** The soft shadow a cat casts on the ground, and the thin edge that carries a coat the ground cannot. */
export const CONTACT = { colour: "#12352a", opacity: 0.26, rx: 27, ry: 4.6 } as const;
export const CONTOUR = { colour: "#12352a", opacity: 0.75, width: 1.2 } as const;

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour laid over another at some opacity, as #rrggbb. */
export function blend(top: string, over: string, opacity: number): string {
  const t = rgb(top);
  const o = rgb(over);
  return `#${t.map((v, i) => Math.round(v * opacity + o[i] * (1 - opacity)).toString(16).padStart(2, "0")).join("")}`;
}

export const MIN_CONTRAST = 3;

/** Whether a coat's body is too close to the paving to read without an edge. */
export const needsContour = (fur: FurKey): boolean =>
  [COURT.floor, COURT.stone].some((g) => contrast(FUR[fur], g) < MIN_CONTRAST);
