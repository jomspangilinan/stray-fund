import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatAvatar } from "../src/components/CatAvatar";
import { FUR, RIBBON, RIBBON_EDGE, type FurKey } from "../src/lib/avatar";
import { blend, CONTOUR, COURT, MIN_CONTRAST, contrast, needsContour } from "../src/lib/courtyard";

const keys = Object.keys(FUR) as FurKey[];
const grounds = [COURT.floor, COURT.stone];

describe("the courtyard ground", () => {
  it("lets white and black bodies stand 3 to 1 off the paving and the wall behind the back cats", () => {
    for (const k of ["white", "black"] as FurKey[]) {
      for (const g of [...grounds, COURT.wallDeep]) expect(contrast(FUR[k], g), `${k} on ${g}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(needsContour(k)).toBe(false);
    }
  });

  it("gives every other coat a soft edge that is itself 2.4 to 1 or more off the paving", () => {
    for (const k of keys) {
      const ok = grounds.every((g) => contrast(FUR[k], g) >= MIN_CONTRAST);
      expect(needsContour(k), k).toBe(!ok);
      if (!ok) for (const g of grounds) expect(contrast(blend(CONTOUR.colour, g, CONTOUR.opacity), g), `${k} edge on ${g}`).toBeGreaterThanOrEqual(2.4);
    }
  });

  it("keeps the paving a mid tone, so a pale coat never matches it again", () => {
    for (const g of grounds) expect(contrast("#ffffff", g)).toBeGreaterThan(3);
  });

  it("draws the edge under the fur of a pale cat and none on a white or black one", () => {
    const draw = (base: FurKey) => renderToStaticMarkup(createElement(CatAvatar, { avatar: { pattern: "solid", base, accent: "grey" }, id: "c1" }));
    expect(draw("cream")).toContain(`stroke-opacity="${CONTOUR.opacity}"`);
    expect(draw("silver")).toContain(`stroke="${CONTOUR.colour}"`);
    expect(draw("white")).not.toContain(`stroke="${CONTOUR.colour}"`);
    expect(draw("black")).not.toContain(`stroke="${CONTOUR.colour}"`);
  });

  it("keeps the blue ribbon readable on every coat, by its fill or by its white edge", () => {
    for (const k of keys) expect(Math.max(contrast(RIBBON, FUR[k]), contrast(RIBBON_EDGE, FUR[k])), k).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("sets the ribbon on the crown, tilted, above the eyes", () => {
    const html = renderToStaticMarkup(createElement(CatAvatar, { avatar: { pattern: "solid", base: "cream", accent: "grey" }, id: "c1", ribbon: true }));
    const at = /<g transform="translate\(([\d.]+) ([\d.]+)\) rotate\((-?\d+)\)/.exec(html);
    expect(at).not.toBeNull();
    const [, x, y, tilt] = at!;
    expect(Number(y)).toBeLessThan(24);
    expect(Math.abs(Number(x) - 40)).toBeLessThan(4);
    expect(Number(tilt)).not.toBe(0);
  });
});
