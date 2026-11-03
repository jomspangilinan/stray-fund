import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatAvatar } from "../src/components/CatAvatar";
import { Yard } from "../src/components/Yard";
import { AVATAR_PATTERNS, EYE, FUR, RIBBON, catAvatar, type Avatar } from "../src/lib/avatar";
import type { YardCat } from "../src/lib/yard";
import type { PublicYard } from "../src/server/public";

const goal = { neutered: 4, goal: 30, area: "Somewhere", percent: 13 };
const cat = (id: string, name: string, avatar: Avatar, group: YardCat["group"] = "waiting"): YardCat => ({
  id,
  name,
  group,
  statusLabel: group === "waiting" ? "Waiting for funding" : "Neutered",
  avatar,
  marks: [],
  female: false,
});
const yard = (cats: YardCat[], stage: PublicYard["stage"] = 1): PublicYard => ({ cats, total: cats.length, stage, goal });

describe("CatAvatar", () => {
  it("draws every pattern from palette colours only", () => {
    const hexes = new Set<string>([...Object.values(FUR), ...Object.values(EYE)].map((h) => h.toLowerCase()));
    for (const pattern of AVATAR_PATTERNS) {
      const html = renderToStaticMarkup(createElement(CatAvatar, { avatar: { pattern, base: "ginger", accent: "brown" }, id: "cat-1", marks: ["collar", "tip"] }));
      expect(html).toContain("<svg");
      expect(html).not.toContain("<script");
      expect(html).toContain(FUR.ginger);
      for (const m of html.match(/#[0-9a-fA-F]{6}/g) ?? []) {
        // Either a palette colour or one of the fixed drawing colours, never anything else.
        expect(/^#(e7a3a0|12352a|df6f69|f2c54f|d98585|5b4a44)$/i.test(m) || m.toLowerCase() === RIBBON || hexes.has(m.toLowerCase())).toBe(true);
      }
    }
  });

  it("draws a ribbon only when told she is a girl, never for anything else, and nothing but a flag reaches it", () => {
    const a: Avatar = { pattern: "tabby", base: "brown", accent: "ginger" };
    const draw = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id: "cat-1", ...props }));
    expect(draw({})).not.toContain(RIBBON);
    expect(draw({ ribbon: false })).not.toContain(RIBBON);
    const girl = draw({ ribbon: true });
    expect(girl).toContain(RIBBON);
    expect(girl).not.toContain("avatar-ribbon-pop");
    // A collar and a ribbon are different colours and can sit together.
    const both = draw({ ribbon: true, marks: ["collar"] });
    expect(both).toContain(RIBBON);
    expect(both).toContain("#df6f69");
    // Only the pop on the reveal carries the animation class.
    expect(draw({ ribbon: true, ribbonPop: true })).toContain("avatar-ribbon-pop");
    expect(draw({ ribbon: false, ribbonPop: true })).not.toContain(RIBBON);
    // Text where a flag should be draws nothing from the text.
    expect(draw({ ribbon: "<script>" })).not.toContain("script");
  });

  it("draws the same cat for the same id and shows the tail, eye and face details from the id", () => {
    const a: Avatar = { pattern: "solid", base: "black", accent: "grey" };
    const draw = (id: string) => renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id }));
    expect(draw("abc")).toBe(draw("abc"));
    const ids = Array.from({ length: 40 }, (_, i) => `cat-${i}`);
    expect(new Set(ids.map(draw)).size).toBeGreaterThan(8);
    const all = ids.map(draw).join("");
    expect(all).toContain("stroke-dashoffset"); // a tail tip
    expect(all).toContain("L71 45"); // a kinked tail
  });

  it("never puts model text into the markup", () => {
    const evil = `"><script>alert(1)</script>`;
    const a = catAvatar({ colors: [evil], markings: evil }, evil);
    const html = renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id: "cat-1" }));
    expect(html).not.toContain("alert");
    expect(html).not.toContain("script");
  });

  it("shows only earned marks", () => {
    const a: Avatar = { pattern: "solid", base: "grey", accent: "cream" };
    const none = renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id: "cat-1" }));
    const collar = renderToStaticMarkup(createElement(CatAvatar, { avatar: a, id: "cat-1", marks: ["collar"] }));
    expect(collar).toContain("#f2c54f");
    expect(none).not.toContain("#f2c54f");
  });
});

describe("Yard", () => {
  const a: Avatar = { pattern: "tabby", base: "ginger", accent: "brown" };

  it("makes every cat a real link with a name and a status, in a list", () => {
    const html = renderToStaticMarkup(createElement(Yard, { yard: yard([cat("11111111-1111-4111-8111-111111111111", "Mimi", a), cat("22222222-2222-4222-8222-222222222222", "Kiko", a, "neutered")]) }));
    expect(html).toContain('<ul class="yard-cats" aria-label="Cats in the yard">');
    expect(html).toContain('href="/cats/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('aria-label="Mimi, Waiting for funding"');
    expect(html).toContain('aria-label="Kiko, Neutered"');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toMatch(/class="yard-name"[^>]*>Mimi</);
  });

  it("reads the goal from real counts and keeps the donate-free picture decorative", () => {
    const html = renderToStaticMarkup(createElement(Yard, { yard: yard([cat("11111111-1111-4111-8111-111111111111", "Mimi", a)]) }));
    expect(html).toContain("4 of 30 neutered");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="4"');
    expect(html).toContain('class="yard-art" aria-hidden="true"');
  });

  it("invites the first spot when there are no cats", () => {
    const html = renderToStaticMarkup(createElement(Yard, { yard: yard([], 0) }));
    expect(html).toContain("No cats yet");
    expect(html).toContain('href="/spot"');
    expect(html).toContain("Spot a cat");
    expect(html).not.toContain("first cat");
    expect(html).not.toContain("See all");
  });

  it("only adds to the yard as the stages grow", () => {
    const art = (s: 0 | 1 | 2 | 3) => renderToStaticMarkup(createElement(Yard, { yard: yard([], s) })).length;
    expect(art(1)).toBeGreaterThan(art(0));
    expect(art(2)).toBeGreaterThan(art(1));
    expect(art(3)).toBeGreaterThan(art(2));
  });

  it("places cats by id, not by anything else", () => {
    const one = renderToStaticMarkup(createElement(Yard, { yard: yard([cat("11111111-1111-4111-8111-111111111111", "Mimi", a)]) }));
    const again = renderToStaticMarkup(createElement(Yard, { yard: yard([cat("11111111-1111-4111-8111-111111111111", "Mimi", { ...a, base: "grey" })]) }));
    const pos = (h: string) => h.match(/left:[^;]+;top:[^;]+/)?.[0];
    expect(pos(one)).toBe(pos(again));
  });
});

describe("yard motion css", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));

  it("gives still cats under reduced motion", () => {
    for (const sel of [".yard-link", ".avatar", ".avatar-tail", ".avatar-eyes"]) expect(reduced).toContain(sel);
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it("pauses while hidden or off screen, and animates transform and opacity only", () => {
    expect(css).toContain('.yard-stage[data-paused="true"]');
    expect(css).toContain("animation-play-state: paused");
    const frames = [...css.matchAll(/@keyframes (yard-[a-z]+) \{([\s\S]*?)\n\}/g)];
    expect(frames.length).toBe(4);
    for (const [, name, body] of frames) {
      const props = [...body.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      expect(props.every((p) => p === "transform"), `${name} animates ${props.join(",")}`).toBe(true);
    }
  });
});
