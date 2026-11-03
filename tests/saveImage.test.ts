import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BACKGROUND_NOTE, SaveImage } from "../src/components/SaveImage";

const draw = (note: "over" | "below") =>
  renderToStaticMarkup(createElement(SaveImage, { catId: "c1", iconClass: "right-2 top-2", note } as ComponentProps<typeof SaveImage>, createElement("img", { alt: "" })));

describe("Save image", () => {
  it("shows the reminder to check the background before any tap, in either place", () => {
    for (const note of ["over", "below"] as const) expect(draw(note)).toContain(BACKGROUND_NOTE);
    expect(BACKGROUND_NOTE).toBe("Check the background before you share.");
  });

  it("mounts the live status region empty, so a later fill is announced, and keeps the reminder out of it", () => {
    const html = draw("below");
    expect(html).toContain('role="status"></p>');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain(`<p class="save-line small">${BACKGROUND_NOTE}</p>`);
  });

  it("wraps the photo it is given and puts the icon, not a text strip, over it", () => {
    const html = draw("over");
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("save-icon"));
    expect(html).toContain("save-over");
    expect(html).toContain('aria-label="Save image"');
  });
});
