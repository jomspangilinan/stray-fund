/*
 * Camera frames carry no orientation tag, so a phone held sideways with rotation lock on saves a sideways photo.
 * These pure helpers work out how far to turn the frame so the saved photo is upright.
 *
 * Gravity is read in the W3C convention: `accelerationIncludingGravity` reports the reaction to gravity, so a
 * phone held upright in portrait reads y = +9.8, and one lying face up reads z = +9.8. The x axis runs to the
 * right of the screen and y to its top. Older iOS Safari reports the opposite sign; `gravityFromMotion` fixes that.
 */
import type { Box } from "./catDetect";

/** Degrees clockwise to turn the captured frame. */
export type Turn = 0 | 90 | 180 | 270;

/** Below this much sideways gravity (m/s^2) the phone is flat and says nothing about which way is up. */
const FLAT_LIMIT = 2.5;

/**
 * How far to turn the frame clockwise. `screenAngle` is `screen.orientation.angle`: how far the page is turned
 * counter-clockwise from the phone's natural position (0 when the page is upright in portrait).
 * A phone lying flat gives no reading, so the turn is 0.
 */
export function turnFromGravity(g: { x: number; y: number }, screenAngle: number): Turn {
  if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || Math.hypot(g.x, g.y) < FLAT_LIMIT) return 0;
  // Counter-clockwise tilt of the phone from upright, to the nearest quarter turn. Upright: (0, +) is 0.
  const quarter = Math.round(Math.atan2(g.x, g.y) / (Math.PI / 2));
  const phone = (((quarter % 4) + 4) % 4) * 90;
  const page = ((Math.round(screenAngle / 90) % 4) + 4) % 4 * 90;
  const turn = ((page - phone + 360) % 360) as Turn;
  // Never 180. If the iOS sign guess in gravityFromMotion were wrong, an upright iPhone would read as 180 and
  // every normal photo would flip. A real upside-down photo is rare, and a caretaker can rotate it twice.
  return turn === 180 ? 0 : turn;
}

/** True on iPhone and iPad Safari, the browsers that ask for motion access and report gravity with the opposite sign. */
export function isIos(): boolean {
  if (typeof DeviceMotionEvent === "undefined") return false;
  return typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown }).requestPermission === "function";
}

/** Puts a reading into the W3C sign convention. iOS reports the opposite sign. */
export function gravityFromMotion(g: { x: number | null; y: number | null }, ios: boolean): { x: number; y: number } | null {
  if (g.x == null || g.y == null) return null;
  return ios ? { x: -g.x, y: -g.y } : { x: g.x, y: g.y };
}

/** A box in fractions of the photo, moved to where it lands after the photo is turned clockwise. */
export function turnBox(b: Box, turn: Turn): Box {
  switch (turn) {
    case 90:
      return { x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w };
    case 180:
      return { x: 1 - b.x - b.w, y: 1 - b.y - b.h, w: b.w, h: b.h };
    case 270:
      return { x: b.y, y: 1 - b.x - b.w, w: b.h, h: b.w };
    default:
      return b;
  }
}

/** The same clockwise turn, named for a caretaker rotating a stored photo's cat box. */
export const rotateBox = turnBox;
