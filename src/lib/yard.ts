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

/**
 * Where a cat's feet rest, as a percent of the yard. Three loose rows, staggered, none on the wall. Each row has
 * four cats about 22 percent apart, so a name tag under a cat has room, and none sits in the far right corner.
 */
export const YARD_SLOTS: readonly { x: number; y: number }[] = [
  { x: 13, y: 56 }, { x: 35, y: 54 }, { x: 57, y: 57 }, { x: 79, y: 55 },
  { x: 24, y: 73 }, { x: 46, y: 71 }, { x: 68, y: 74 }, { x: 88, y: 72 },
  { x: 13, y: 89 }, { x: 35, y: 87 }, { x: 57, y: 90 }, { x: 79, y: 88 },
];

/** Longest name a yard tag shows; a longer one is cut with an ellipsis. */
export const TAG_MAX = 30;

export const tagName = (name: string): string => {
  const chars = Array.from(name);
  return chars.length <= TAG_MAX ? name : `${chars.slice(0, TAG_MAX - 1).join("").trimEnd()}\u2026`;
};

const hash = hashOf;

export const slotFor = (id: string): number => hash(id) % YARD_SLOTS.length;

/** A calm per-cat number in [0, 1) for staggering motion, so cats do not move in step. */
export const jitterFor = (id: string, salt: number): number => (hash(`${id}:${salt}`) % 1000) / 1000;

/** Each cat gets its preferred slot, or the next free one. Order decides who yields, so pass the priority order. */
export function slotsFor(ids: string[]): Map<string, number> {
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    let s = slotFor(id);
    for (let n = 0; n < YARD_SLOTS.length && taken.has(s); n++) s = (s + 1) % YARD_SLOTS.length;
    taken.add(s);
    out.set(id, s);
  }
  return out;
}

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
