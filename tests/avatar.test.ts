import { describe, expect, it } from "vitest";
import { AVATAR_PATTERNS, EYE, FACES, FUR, NEUTRAL_AVATAR, RIBBON, RIBBON_EDGE, TAILS, catAvatar, catDetails, parseAvatar } from "../src/lib/avatar";

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

  it("gives a neutral cat for other, missing and unrecognised patterns", () => {
    for (const p of ["other", null, undefined, "", 42, "zebra", {}]) {
      expect(catAvatar({ colors: ["orange"], markings: "" }, p)).toEqual(NEUTRAL_AVATAR);
    }
    expect(NEUTRAL_AVATAR.pattern).toBe("unknown");
  });

  it("draws a mostly white cat with dark patches as patched, not as a tuxedo", () => {
    const led = catAvatar({ colors: ["white", "black"], markings: "scattered dark patches on back and head" }, "bicolor");
    expect(led).toEqual({ pattern: "patched", base: "white", accent: "black" });
    const said = catAvatar({ colors: ["black", "white"], markings: "mostly white with black patches" }, "bicolor");
    expect(said).toEqual({ pattern: "patched", base: "white", accent: "black" });
    expect(catAvatar({ colors: ["white", "orange"], markings: "" }, "bicolor")).toEqual({ pattern: "patched", base: "white", accent: "ginger" });
    expect(catAvatar({ colors: ["white"], markings: "" }, "bicolor")).toEqual({ pattern: "patched", base: "white", accent: "black" });
    // A dark cat with white parts stays a dark bicolour, and a tuxedo stays a tuxedo.
    expect(catAvatar({ colors: ["black", "white"], markings: "white chest and paws" }, "bicolor")).toEqual({ pattern: "bicolour", base: "black", accent: "white" });
    expect(catAvatar({ colors: ["white", "black"], markings: "mostly black with a white chest" }, "bicolor").pattern).toBe("bicolour");
    expect(catAvatar({ colors: ["black", "white"], markings: "" }, "tuxedo").pattern).toBe("tuxedo");
  });

  it("gives a white cat a cap when the markings say cap or mask, and colourpoint its own look", () => {
    expect(catAvatar({ colors: ["white", "grey"], markings: "grey cap over the head and ears" }, "bicolor")).toEqual({ pattern: "cap", base: "white", accent: "grey" });
    expect(catAvatar({ colors: ["cream", "brown"], markings: "dark mask and ears" }, "colorpoint")).toEqual({ pattern: "colourpoint", base: "cream", accent: "brown" });
    const bare = catAvatar(null, "colorpoint");
    expect(bare.pattern).toBe("colourpoint");
    expect(bare.base).not.toBe(bare.accent);
  });

  it("maps free-text colours to the fixed palette", () => {
    expect(catAvatar({ colors: ["Marmalade orange"] }, "solid").base).toBe("ginger");
    expect(catAvatar({ colors: ["jet black"] }, "solid").base).toBe("black");
    expect(catAvatar({ colors: ["slate gray"] }, "solid").base).toBe("grey");
    expect(catAvatar({ colors: ["cream"] }, "solid").base).toBe("cream");
    expect(catAvatar({ colors: ["chocolate brown", "white"] }, "tabby").base).toBe("brown");
  });

  it("uses sensible defaults when colours are missing, and keeps base and accent distinct", () => {
    for (const p of ["tabby", "solid", "tuxedo", "calico", "tortoiseshell", "bicolor", "colorpoint"]) {
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

describe("parseAvatar for the new looks", () => {
  it("accepts the new patterns and still refuses unknown values", () => {
    for (const pattern of ["patched", "cap", "colourpoint"]) {
      expect(parseAvatar({ pattern, base: "white", accent: "black" })).toEqual({ pattern, base: "white", accent: "black" });
    }
    expect(parseAvatar({ pattern: "patched", base: "white", accent: "#000" })).toBeNull();
    expect(parseAvatar({ pattern: "bicolor", base: "white", accent: "black" })).toBeNull();
  });
});

describe("catDetails", () => {
  it("is the same for the same id and always from the fixed tables", () => {
    for (const pattern of AVATAR_PATTERNS) {
      for (let i = 0; i < 30; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        const d = catDetails(id, pattern);
        expect(catDetails(id, pattern)).toEqual(d);
        expect(Object.keys(EYE)).toContain(d.eyes);
        expect(TAILS).toContain(d.tail);
        expect(FACES).toContain(d.face);
        expect([0, 1, 2]).toContain(d.layout);
        expect(typeof d.flip).toBe("boolean");
      }
    }
  });

  it("varies between cats, gives colourpoints blue eyes, and keeps face marks off busy coats", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `cat-${i}`);
    const ds = ids.map((id) => catDetails(id, "solid"));
    expect(new Set(ds.map((d) => d.eyes)).size).toBe(3);
    expect(new Set(ds.map((d) => d.tail)).size).toBe(3);
    expect(new Set(ds.map((d) => d.face)).size).toBe(3);
    expect(new Set(ds.map((d) => d.layout)).size).toBe(3);
    for (const id of ids) {
      expect(catDetails(id, "colourpoint").eyes).toBe("blue");
      for (const p of ["tabby", "calico", "tortoiseshell", "tuxedo", "cap", "colourpoint", "unknown"] as const) {
        expect(catDetails(id, p).face).toBe("none");
      }
      expect(catDetails(id, "patched").face).not.toBe("blaze");
    }
  });
});

describe("the ribbon", () => {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hue = (hex: string) => {
    const [r, g, b] = rgb(hex);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  it("is one fixed colour from the tables, and an edge, both plain hex", () => {
    expect(RIBBON).toMatch(/^#[0-9a-f]{6}$/i);
    expect(RIBBON_EDGE).toBe(FUR.white);
  });

  it("is clearly not the vaccinated collar red, and not a coat colour", () => {
    const diff = Math.abs(hue(RIBBON) - hue("#df6f69"));
    expect(Math.min(diff, 360 - diff)).toBeGreaterThan(90);
    expect(Object.values(FUR)).not.toContain(RIBBON);
  });

  it("can be read on every coat: the fill or its edge stands out from each fur colour", () => {
    for (const [name, fur] of Object.entries(FUR)) {
      expect(Math.max(contrast(RIBBON, fur), contrast(RIBBON_EDGE, fur)), name).toBeGreaterThanOrEqual(3);
    }
  });
});
