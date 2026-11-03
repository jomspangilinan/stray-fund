import { describe, expect, it } from "vitest";
import { fuzzLocation } from "../src/server/location";

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe("fuzzLocation", () => {
  for (const [lat, lng] of [
    [14.6, 121.0],
    [64.1, -21.9],
    [-33.9, 151.2],
  ]) {
    it(`offsets 300 to 700 m at latitude ${lat} over 1000 runs`, () => {
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < 1000; i++) {
        const out = fuzzLocation(lat, lng);
        const d = haversine({ lat, lng }, out);
        min = Math.min(min, d);
        max = Math.max(max, d);
        expect(d).toBeGreaterThanOrEqual(299.5);
        expect(d).toBeLessThanOrEqual(700.5);
      }
      expect(min).toBeLessThan(330);
      expect(max).toBeGreaterThan(670);
    });
  }

  it("covers every bearing", () => {
    const quadrants = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const o = fuzzLocation(14.6, 121);
      quadrants.add(`${Math.sign(o.lat - 14.6)}${Math.sign(o.lng - 121)}`);
    }
    expect(quadrants.size).toBe(4);
  });

  it("is deterministic for an injected rng and maps rng to distance and bearing", () => {
    const seq = [0, 0]; // distance 300 m, bearing 0 (north)
    const out = fuzzLocation(14.6, 121, () => seq.shift() ?? 0);
    expect(out.lng).toBeCloseTo(121, 5);
    expect(haversine({ lat: 14.6, lng: 121 }, out)).toBeCloseTo(300, 0);
    expect(out.lat).toBeGreaterThan(14.6);
  });

  it("returns degrees with at most 6 decimals", () => {
    const o = fuzzLocation(14.5995, 120.9842);
    for (const v of [o.lat, o.lng]) expect(String(v).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });

  it("rejects invalid coordinates", () => {
    expect(() => fuzzLocation(NaN, 0)).toThrow(RangeError);
    expect(() => fuzzLocation(91, 0)).toThrow(RangeError);
    expect(() => fuzzLocation(0, 181)).toThrow(RangeError);
  });
});
