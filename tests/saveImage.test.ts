import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BACKGROUND_NOTE, SaveImage } from "../src/components/SaveImage";

const draw = (variant: "icon" | "button") =>
  renderToStaticMarkup(createElement(SaveImage, { catId: "c1", variant } as ComponentProps<typeof SaveImage>, createElement("img", { alt: "" })));

describe("Save image", () => {
  it("shows the reminder as plain text before any tap, in either variant", () => {
    for (const v of ["icon", "button"] as const) expect(draw(v)).toContain(`<p class="save-note">${BACKGROUND_NOTE}</p>`);
    expect(BACKGROUND_NOTE).toBe("Check the background before you share.");
  });

  it("mounts the live status region empty and off screen, so a later fill is announced, and keeps the reminder out of it", () => {
    const html = draw("icon");
    expect(html).toContain('class="sr-only" role="status"></p>');
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  it("puts a 44 px icon over the photo, after it, and no outline button", () => {
    const html = draw("icon");
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("save-icon"));
    expect(html).toContain('aria-label="Save image"');
    expect(html).not.toContain("save-btn");
  });

  it("puts a full-width outline button under the card, then the reminder, and no icon over it", () => {
    const html = draw("button");
    expect(html).not.toContain("save-icon");
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("save-btn"));
    expect(html.indexOf("save-btn")).toBeLessThan(html.indexOf("save-note"));
    expect(html).toContain("Save image</button>");
  });
});
