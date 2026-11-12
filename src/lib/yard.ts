import { hashOf, type Avatar } from "./avatar";

/*
 * The yard is a made-up courtyard, not a map. A cat's place comes from a hash of its id and nothing else, so
 * no coordinate, exact or fuzzed, can influence it. The yard only ever grows: stages come from real counts and
 * nothing is taken away for being quiet.
 */

export const YARD_MAX = 12;

export type YardGroup = "waiting" | "in-care" | "neutered" | "home" | "adopted";
export type CareMark = "collar" | "tip";

/** What the yard may know about a cat. Whitelisted field by field in getYard. */
export type YardCat = {
  id: string;
  name: string;
  group: YardGroup;
  statusLabel: string;
  avatar: Avatar;
  marks: CareMark[];
  /** A girl wears a ribbon. Only this yes or no reaches the drawing. */
  female: boolean;
};

/** At 3 cats or fewer a cat is this many times its size at a full yard. */
export const YARD_FEW = 3;
export const YARD_BIG = 1.95;
/** Six cats keep the size they always had; the sizes between 3 and 6 slide to it. */
export const YARD_MID = 6;
const MID_SCALE = 1.5 - (0.5 * (YARD_MID - YARD_FEW)) / (YARD_MAX - YARD_FEW);

/** Cats scale with how many there are: largest at 1 to 3, steady from 6 to today's size at 12, smooth between. */
export function yardScale(count: number): number {
  if (!(count > YARD_FEW)) return YARD_BIG;
  if (count >= YARD_MAX) return 1;
  if (count <= YARD_MID) return YARD_BIG - ((YARD_BIG - MID_SCALE) * (count - YARD_FEW)) / (YARD_MID - YARD_FEW);
  return MID_SCALE - ((MID_SCALE - 1) * (count - YARD_MID)) / (YARD_MAX - YARD_MID);
}

/** Width of a cat as a percent of the yard at a full yard: a little larger toward the front, which reads as nearer. */
export const widthAt = (y: number): number => 12 + ((y - 50) / 40) * 3;

/** How many cats stand in each row, back to front, for every count from 1 to 12. */
const ROW_COUNTS: readonly (readonly number[])[] = [
  [1], [2], [3], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [5, 5], [4, 4, 3], [4, 4, 4],
];
/** Where a row's feet rest, as a percent of the yard height: one row, two, or three loose rows, none on the wall. */
const ROW_Y: readonly (readonly number[])[] = [[83], [54, 91], [40.5, 65, 92]];
const ROW_LEFT = 11;
const ROW_SPAN = 77.5;
const ROW_STAGGER = 0.475;

/**
 * Where each cat's feet rest, as a percent of the yard, for a yard holding this many. Rows are staggered so a name
 * tag under a cat has room, and a count has exactly as many places as cats, so every place is taken.
 */
export function yardSlots(count: number): { x: number; y: number }[] {
  const rows = ROW_COUNTS[Math.min(YARD_MAX, Math.max(1, count)) - 1];
  const ys = ROW_Y[rows.length - 1];
  return rows.flatMap((k, r) => {
    const step = k > 1 ? ROW_SPAN / (k - 1 + ROW_STAGGER) : 0;
    return Array.from({ length: k }, (_, i) => ({
      x: k === 1 ? (rows.length === 1 ? 50 : r % 2 ? 65 : 35) : ROW_LEFT + i * step + (r % 2 ? step * ROW_STAGGER : 0),
      y: ys[r],
    }));
  });
}

/** The yard as a phone shows it (390 x 664), and the part of a drawn cat that is cat. Used to keep cats clear. */
const PHONE = { w: 390, h: 288, tagW: 64, tagH: 26 } as const;
/** Where a drawn cat's feet rest inside its square, as a share of its height. The name tag's top edge is this line. */
export const FEET = 0.9375;
/** How far a cat strolls sideways, as a share of its own width (the largest --dx the yard sets). */
const WANDER = 0.2;

/** A cat's size and where it stands, as percents of the yard width, kept inside with room to stroll. */
export function placeAt(slot: { x: number; y: number }, scale: number): { x: number; y: number; w: number } {
  const w = widthAt(slot.y) * scale;
  const room = w * (0.5 + WANDER);
  return { x: Math.min(100 - room, Math.max(room, slot.x)), y: slot.y, w };
}

type Box = { l: number; t: number; r: number; b: number };

/** The pixels the drawn cat and its name tag cover on a phone. */
export function phoneBoxes(slot: { x: number; y: number }, scale: number): { cat: Box; tag: Box } {
  const p = placeAt(slot, scale);
  const size = (p.w / 100) * PHONE.w;
  const cx = (p.x / 100) * PHONE.w;
  const feet = (p.y / 100) * PHONE.h - (1 - FEET) * size;
  return {
    cat: { l: cx - size / 2 + 0.2 * size, r: cx - size / 2 + 0.9 * size, t: feet - 0.8 * size, b: feet },
    tag: { l: cx - PHONE.tagW / 2, r: cx + PHONE.tagW / 2, t: feet, b: feet + PHONE.tagH },
  };
}

/** Longest name a yard tag shows; a longer one is cut with an ellipsis. */
export const TAG_MAX = 30;

export const tagName = (name: string): string => {
  const chars = Array.from(name);
  return chars.length <= TAG_MAX ? name : `${chars.slice(0, TAG_MAX - 1).join("").trimEnd()}\u2026`;
};

const hash = hashOf;

/** A cat's preferred place, from its id alone. Over a yard of fewer cats it wraps onto that yard's places. */
export const slotFor = (id: string): number => hash(id) % YARD_MAX;

/** A calm per-cat number in [0, 1) for staggering motion, so cats do not move in step. */
export const jitterFor = (id: string, salt: number): number => (hash(`${id}:${salt}`) % 1000) / 1000;

/** Each cat gets its preferred place, or the next free one. Order decides who yields, so pass the priority order. */
export function slotsFor(ids: string[]): Map<string, number> {
  const places = Math.max(1, ids.length);
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    let s = slotFor(id) % places;
    for (let n = 0; n < places && taken.has(s); n++) s = (s + 1) % places;
    taken.add(s);
    out.set(id, s);
  }
  return out;
}

/*
 * The wide yard. Past YARD_SECTION cats the yard gets another section of courtyard, so it never crowds. Zooming
 * out shows more sections at once (2 x 2, then 3 x 3); zooming in goes back to one.
 */

/** Cats in one section of the yard. */
export const YARD_SECTION = 10;
/** Sections across (and down) one screen, from zoomed in to zoomed out. */
export const ZOOM_LEVELS = [1, 2, 3] as const;
export type Zoom = (typeof ZOOM_LEVELS)[number];

/** The cats split into sections, in the yard's order, every cat in exactly one. Always at least one section. */
export function yardSections<T>(cats: readonly T[], size: number = YARD_SECTION): T[][] {
  const n = Math.max(1, Math.ceil(cats.length / size));
  return Array.from({ length: n }, (_, i) => cats.slice(i * size, (i + 1) * size));
}

/** Screens at a zoom: each screen holds zoom x zoom sections. */
export const screensAt = (sections: number, zoom: Zoom): number => Math.max(1, Math.ceil(sections / (zoom * zoom)));

/** The screen that shows a section at a zoom, so zooming keeps the same cats in view. */
export const screenOf = (section: number, zoom: Zoom): number => Math.floor(section / (zoom * zoom));

/**
 * Which screens to draw: the one on show and its neighbours, so a slide has something to slide to. Every
 * other screen is not in the page at all, however many cats there are.
 */
export function screensToDraw(current: number, total: number): number[] {
  return [current - 1, current, current + 1].filter((s) => s >= 0 && s < total);
}

/**
 * One size for every section of a wide yard, set by a full section, so a last section with two cats does not
 * draw them giant. A yard of one section keeps today's sizes.
 */
export const sectionScale = (sections: number, inThisSection: number): number => yardScale(sections > 1 ? YARD_SECTION : inThisSection);

/** 0 bare, 1 first touches, 2 homely, 3 festive. From cats neutered against the goal. */
export function yardStage(neutered: number, goal: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(neutered) || !Number.isFinite(goal) || goal <= 0 || neutered <= 0) return 0;
  const r = neutered / goal;
  if (r >= 0.75) return 3;
  if (r >= 0.35) return 2;
  if (r >= 0.1) return 1;
  return 0;
}

/** Up to YARD_MAX cats: waiting cats the viewer helped, waiting cats, the viewer's other helped cats, then the rest. */
export function pickYard(all: YardCat[], helped: ReadonlySet<string>, max: number = YARD_MAX): YardCat[] {
  const rank = (c: YardCat) => (c.group === "waiting" ? 0 : 2) + (helped.has(c.id) ? 0 : 1);
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.c);
}

/** Small marks for care that happened. Never for care that has not. */
export function careMarks(journey: { step: string; done: boolean }[]): CareMark[] {
  const done = (s: string) => journey.some((j) => j.step === s && j.done);
  const out: CareMark[] = [];
  if (done("Vaccinated")) out.push("collar");
  if (done("Neutered")) out.push("tip");
  return out;
}
