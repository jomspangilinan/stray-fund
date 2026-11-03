import { randomBytes } from "node:crypto";

const EARTH_RADIUS_M = 6371008.8;
const MIN_OFFSET_M = 300;
const MAX_OFFSET_M = 700;

/** Uniform in [0, 1) from 48 random bits. */
const cryptoRng = (): number => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Moves a point a random distance (uniform 300 to 700 m) along a uniform random bearing,
 * using the great-circle destination formula. Computed once at cat creation and stored.
 */
export function fuzzLocation(
  lat: number,
  lng: number,
  rng: () => number = cryptoRng,
): { lat: number; lng: number } {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError("Invalid latitude");
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new RangeError("Invalid longitude");
  const distance = MIN_OFFSET_M + rng() * (MAX_OFFSET_M - MIN_OFFSET_M);
  const bearing = rng() * 2 * Math.PI;
  const delta = distance / EARTH_RADIUS_M;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lng * Math.PI) / 180;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearing);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  const outLng = ((((lambda2 * 180) / Math.PI + 540) % 360) - 180);
  return { lat: round6((phi2 * 180) / Math.PI), lng: round6(outLng) };
}
