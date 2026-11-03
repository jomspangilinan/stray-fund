import { describe, expect, it } from "vitest";
import { AVATAR_PATTERNS, FUR, NEUTRAL_AVATAR, catAvatar, parseAvatar } from "../src/lib/avatar";

const FUR_KEYS = Object.keys(FUR);

describe("catAvatar", () => {
  it.each([
    ["tabby", "tabby"],
    ["solid", "solid"],
    ["tuxedo", "tuxedo"],
    ["calico", "calico"],
    ["tortoiseshell", "tortoiseshell"],
    ["bicolor", "bicolour"],
  ])("maps the %s coat to the %s look", (stored, pattern) => {
    expect(catAvatar({ colors: ["orange"], markings: "" }, stored).pattern).toBe(pattern);
  });

  it("gives a neutral cat for colourpoint, other, missing and unrecognised patterns", () => {
    for (const p of ["colorpoint", "other", null, undefined, "", 42, "zebra", {}]) {
      expect(catAvatar({ colors: ["orange"], markings: "" }, p)).toEqual(NEUTRAL_AVATAR);
    }
    expect(NEUTRAL_AVATAR.pattern).toBe("unknown");
  });

  it("maps free-text colours to the fixed palette", () => {
    expect(catAvatar({ colors: ["Marmalade orange"] }, "solid").base).toBe("ginger");
    expect(catAvatar({ colors: ["jet black"] }, "solid").base).toBe("black");
    expect(catAvatar({ colors: ["slate gray"] }, "solid").base).toBe("grey");
    expect(catAvatar({ colors: ["cream"] }, "solid").base).toBe("cream");
    expect(catAvatar({ colors: ["chocolate brown", "white"] }, "tabby").base).toBe("brown");
  });

  it("uses sensible defaults when colours are missing, and keeps base and accent distinct", () => {
    for (const p of ["tabby", "solid", "tuxedo", "calico", "tortoiseshell", "bicolor"]) {
      for (const coat of [null, {}, { colors: [] }, { colors: ["orange", "orange"] }, { colors: "orange" }, { colors: [1, null] }]) {
        const a = catAvatar(coat, p);
        expect(FUR_KEYS).toContain(a.base);
        expect(FUR_KEYS).toContain(a.accent);
        if (a.pattern !== "solid") expect(a.accent).not.toBe(a.base);
      }
    }
  });

  it("is deterministic", () => {
    const coat = { colors: ["orange", "white"], markings: "white socks" };
    expect(catAvatar(coat, "bicolor")).toEqual(catAvatar(structuredClone(coat), "bicolor"));
  });

  it("never lets model text reach the output", () => {
    const hostile = `<script>alert(1)</script>" onload="x" orange`;
    const a = catAvatar({ colors: [hostile, "url(javascript:1)"], markings: `"><img src=x onerror=1>` }, "tabby");
    expect(Object.keys(a).sort()).toEqual(["accent", "base", "pattern"]);
    expect(AVATAR_PATTERNS).toContain(a.pattern);
    expect(FUR_KEYS).toContain(a.base);
    expect(FUR_KEYS).toContain(a.accent);
    expect(JSON.stringify(a)).not.toMatch(/[<>"(]script|onload|javascript|img/);
  });
});

describe("parseAvatar", () => {
  it("accepts only fixed palette values", () => {
    expect(parseAvatar({ pattern: "tabby", base: "ginger", accent: "brown" })).toEqual({ pattern: "tabby", base: "ginger", accent: "brown" });
    expect(parseAvatar({ pattern: "tabby", base: "<b>", accent: "brown" })).toBeNull();
    expect(parseAvatar({ pattern: "wolf", base: "ginger", accent: "brown" })).toBeNull();
    expect(parseAvatar(null)).toBeNull();
    expect(parseAvatar("tabby")).toBeNull();
  });

  it("drops extra keys", () => {
    const a = parseAvatar({ pattern: "solid", base: "grey", accent: "cream", note: "x" });
    expect(a).toEqual({ pattern: "solid", base: "grey", accent: "cream" });
  });
});
