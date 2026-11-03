import { FUR, type FurKey } from "./avatar";

/*
 * The ground a cat stands on, and what keeps a cat visible on it. One set of values, read by the yard, the
 * reveal strip and the saved image, so a coat that stands out in one stands out in all.
 */
const FLOOR = "#A08262";
/** The paving stripes are the ground this much darker, so the two can only move together. */
const STONE_DARKER = 0.08;
const darker = (hex: string, by: number): string =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - by)).toString(16).padStart(2, "0")).join("")}`;

export const COURT = {
  wall: "#7fb2b4",
  wallDeep: "#5f969b",
  floor: FLOOR,
  stone: darker(FLOOR, STONE_DARKER),
} as const;

/** The soft shadow a cat casts on the ground, and the thin edge that carries a coat the ground cannot. */
export const CONTACT = { colour: "#12352a", opacity: 0.26, rx: 27, ry: 4.6 } as const;
export const CONTOUR = { colour: "#12352a", opacity: 0.75, width: 0.8 } as const;

/** The saved image shows the soft edge no wider than this many pixels at 1080 across, however large the cat is drawn. */
export const KEEPSAKE_EDGE_PX = 4;

/** The soft edge, in drawing units, for a cat drawn this many pixels across: the yard's own, or thinner to meet the cap. */
export const edgeFor = (drawnPx: number, maxPx: number = KEEPSAKE_EDGE_PX): number => Math.min(CONTOUR.width, maxPx / (drawnPx / 80));

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
