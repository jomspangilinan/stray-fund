/*
 * The keepsake picture: a 1080 x 1920 courtyard with the cat's real photo framed on the wall. Everything that
 * does not need a canvas lives here so it can be tested: the layout numbers, the crop around the cat, the
 * title lines and the file name.
 */
import type { Avatar } from "./avatar";
import type { Box } from "./catDetect";

export const KEEPSAKE_W = 1080;
export const KEEPSAKE_H = 1920;
export const MAX_OTHERS = 4;
/** Longest name the title will carry before an ellipsis. */
export const MAX_TITLE_NAME = 30;

/** The photo opening inside the frame and mat, in picture pixels. */
export const PHOTO_BOX = { x: 198, y: 418, w: 684, h: 524 } as const;
export const FRAME = { x: 150, y: 370, w: 780, h: 620, mat: 26 } as const;
/** The title and the status under it: one ink for both, the largest and smallest title type, and the gap between them. */
export const TITLE_INK = "#12352A";
export const TITLE_MAX = 132;
export const TITLE_MIN = 72;
export const TITLE_STATUS_GAP = 14;
export const NAIL = { x: 540, y: 332 } as const;

/** The look-alike in front: bottom centre and side of its square. */
export const HERO = { x: 540, bottom: 1760, size: 860 } as const;

/** Where the other cats stand, as bottom centre and side of a square. Fewer cats use the first slots. */
export const BACK_SLOTS: readonly { x: number; bottom: number; size: number }[] = [
  { x: 150, bottom: 1180, size: 200 },
  { x: 930, bottom: 1150, size: 190 },
  { x: 960, bottom: 1600, size: 200 },
  { x: 190, bottom: 1470, size: 230 },
];

/** A cat's place in its photo, as fractions of the photo from the top left. Only a position, never a location. */
export type CatBox = Box;

const FRACTION_SLACK = 1e-6;

/** Reads a box a person's phone sent. Anything outside the photo, or not four finite numbers, is refused. */
export function parseCatBox(v: unknown): CatBox | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const { x, y, w, h } = v as Record<string, unknown>;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [bx, by, bw, bh] = [x, y, w, h] as number[];
  if (bx < 0 || by < 0 || bw <= 0 || bh <= 0 || bx + bw > 1 + FRACTION_SLACK || by + bh > 1 + FRACTION_SLACK) return null;
  return { x: bx, y: by, w: bw, h: bh };
}

/** The camera's box in video pixels as fractions of the frame, kept inside it. Nothing when it is unusable. */
export function toCatBox(box: Box, frame: { w: number; h: number }): CatBox | null {
  if (!(frame.w > 0) || !(frame.h > 0)) return null;
  const x0 = Math.min(1, Math.max(0, box.x / frame.w));
  const y0 = Math.min(1, Math.max(0, box.y / frame.h));
  const x1 = Math.min(1, Math.max(0, (box.x + box.w) / frame.w));
  const y1 = Math.min(1, Math.max(0, (box.y + box.h) / frame.h));
  return parseCatBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** A stored box in the pixels of the photo the picture is cut from. */
export function fromCatBox(box: CatBox | null, photo: { w: number; h: number }): Box | null {
  return box ? { x: box.x * photo.w, y: box.y * photo.h, w: box.w * photo.w, h: box.h * photo.h } : null;
}

export type Rect = { x: number; y: number; w: number; h: number };

const PAD = 0.22;

/**
 * The part of the photo to show, as a rectangle in photo pixels with the frame's shape. With a cat box it
 * is centred on the cat with room around it and never zooms past the photo; with none it is the centre.
 */
export function cropRect(photo: { w: number; h: number }, box: Box | null, aspect = PHOTO_BOX.w / PHOTO_BOX.h): Rect {
  const fitW = Math.min(photo.w, photo.h * aspect);
  const full: Rect = { x: (photo.w - fitW) / 2, y: (photo.h - fitW / aspect) / 2, w: fitW, h: fitW / aspect };
  if (!box || !(box.w > 0) || !(box.h > 0)) return full;
  const bw = box.w * (1 + PAD * 2);
  const bh = box.h * (1 + PAD * 2);
  const w = Math.min(full.w, Math.max(bw, bh * aspect));
  const h = w / aspect;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = Math.min(photo.w - w, Math.max(0, cx - w / 2));
  const y = Math.min(photo.h - h, Math.max(0, cy - h / 2));
  return { x, y, w, h };
}

/** Cuts a long name at the limit, on a letter boundary of what a person sees. */
export function titleName(name: string): string {
  const letters = Array.from(name.trim().replace(/\s+/g, " "));
  return letters.length > MAX_TITLE_NAME ? `${letters.slice(0, MAX_TITLE_NAME - 1).join("").trimEnd()}…` : letters.join("");
}

/** The saved file's name: the cat's name in plain letters, never anything private. */
export function keepsakeFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "cat"}-stray-fund.png`;
}

/** The other cats to stand behind: not this one, at most four, in the yard's own order. */
export function otherCats<T extends { id: string }>(yard: readonly T[], selfId: string): T[] {
  return yard.filter((c) => c.id !== selfId).slice(0, MAX_OTHERS);
}

/** One cat to draw: fixed palette names, a yes or no for the ribbon, and an id that only varies the details. */
export type KeepsakeCat = { id: string; avatar: Avatar; female: boolean };

export type KeepsakeData = {
  name: string;
  /** The cat card's own public status label, so the saved picture never says anything the card does not. */
  statusLabel: string;
  /** Same-origin address of the public photo, served by the app so no canvas ever reads another origin. */
  photo: string;
  /** Where the cat is in that photo, when the camera saw it. Nothing for an older cat. */
  box: CatBox | null;
  hero: KeepsakeCat;
  others: KeepsakeCat[];
};

/** The drawing as a file of its own: the app's styles do not reach it, so it carries its size and namespace. */
export function standaloneSvg(markup: string): string {
  return markup.replace(/<svg /, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" ');
}

/** The day a picture was saved, as "3 Nov 2026", because a saved picture keeps showing a status that may change. */
export function keepsakeDate(d: Date): string {
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} ${d.getFullYear()}`;
}
