import { COURT } from "./courtyard";
import { hashOf } from "./avatar";

/*
 * How a barangay's yard looks, as data: a wall colour, a window shape and a plant, each picked from a fixed table
 * by a hash of the barangay's code. Same barangay, same yard, every time. No AI and no file per barangay.
 *
 * Only the wall, gate, windows and plant change. The ground, the paving and the cat's shadow never do: the cats
 * stand on the ground, and courtyard.ts keeps every coat visible on it.
 */

export type WallKey = "teal" | "terracotta" | "butter" | "lilac" | "sage" | "sky";
export type WindowKey = "mixed" | "round" | "arch" | "square";
export type PlantKey = "pot" | "banana" | "bougainvillea";

export const WALLS: Record<WallKey, { wall: string; wallDeep: string; gate: string; gateInner: string; glass: string }> = {
  // Today's courtyard.
  teal: { wall: COURT.wall, wallDeep: COURT.wallDeep, gate: "#3f7a80", gateInner: "#2f666c", glass: "#b9dcd8" },
  terracotta: { wall: "#d9a07e", wallDeep: "#c0835f", gate: "#8a4b32", gateInner: "#6e3a26", glass: "#f3e3cf" },
  butter: { wall: "#e6cf8a", wallDeep: "#cdb46c", gate: "#7d6a2c", gateInner: "#5f5020", glass: "#f7efd2" },
  lilac: { wall: "#b7a6cf", wallDeep: "#9886b5", gate: "#5e4d80", gateInner: "#4a3c66", glass: "#e6def2" },
  sage: { wall: "#a9c39a", wallDeep: "#8ba97c", gate: "#4f6b45", gateInner: "#3d5536", glass: "#e2eedb" },
  sky: { wall: "#9cc0dd", wallDeep: "#7ea3c2", gate: "#3d6283", gateInner: "#2f4e6b", glass: "#e0edf7" },
};
export const WALL_KEYS = Object.keys(WALLS) as WallKey[];
export const WINDOW_KEYS: readonly WindowKey[] = ["mixed", "round", "arch", "square"];
export const PLANT_KEYS: readonly PlantKey[] = ["pot", "banana", "bougainvillea"];

export type YardLook = { wall: WallKey; windows: WindowKey; plant: PlantKey };

/** Today's courtyard: the yard for the default colony and anywhere with no barangay. */
export const DEFAULT_LOOK: YardLook = { wall: "teal", windows: "mixed", plant: "pot" };

/** The look for a barangay or a city, from its code alone. Null is the default colony. */
export function yardLook(code: string | null): YardLook {
  if (!code) return DEFAULT_LOOK;
  const h = hashOf(`yard:${code}`);
  return {
    wall: WALL_KEYS[h % WALL_KEYS.length],
    windows: WINDOW_KEYS[(h >>> 4) % WINDOW_KEYS.length],
    plant: PLANT_KEYS[(h >>> 8) % PLANT_KEYS.length],
  };
}

/**
 * The look of one section of the wide yard. The first is today's courtyard; after it the wall, the windows and
 * the plant each step through their table at their own pace (6, 4 and 3 long), so no two neighbouring sections
 * look alike and the pattern only repeats after twelve sections.
 */
export function sectionLook(section: number): YardLook {
  const k = Math.max(0, Math.trunc(section));
  return {
    wall: WALL_KEYS[k % WALL_KEYS.length],
    windows: WINDOW_KEYS[k % WINDOW_KEYS.length],
    plant: PLANT_KEYS[k % PLANT_KEYS.length],
  };
}

/** A look from a URL or a prop is checked against the tables, never trusted. */
export function parseLook(v: unknown): YardLook {
  const o = (v ?? {}) as Partial<Record<keyof YardLook, unknown>>;
  const pick = <T extends string>(x: unknown, keys: readonly T[], d: T): T => (keys.includes(x as T) ? (x as T) : d);
  return {
    wall: pick(o.wall, WALL_KEYS, DEFAULT_LOOK.wall),
    windows: pick(o.windows, WINDOW_KEYS, DEFAULT_LOOK.windows),
    plant: pick(o.plant, PLANT_KEYS, DEFAULT_LOOK.plant),
  };
}
