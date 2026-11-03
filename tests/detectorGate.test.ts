import { describe, expect, it } from "vitest";
import { skipDetector } from "../src/lib/catDetect";

describe("skipDetector", () => {
  it("loads when there is no connection info", () => {
    expect(skipDetector(undefined)).toBe(false);
    expect(skipDetector({})).toBe(false);
  });
  it("skips on data saver", () => {
    expect(skipDetector({ saveData: true })).toBe(true);
  });
  it("skips on 2g and 3g, and slow-2g", () => {
    for (const t of ["slow-2g", "2g", "3g"]) expect(skipDetector({ effectiveType: t })).toBe(true);
  });
  it("loads on 4g", () => {
    expect(skipDetector({ effectiveType: "4g", saveData: false })).toBe(false);
  });
});
