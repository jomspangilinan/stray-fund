/*
 * The look-alike of a cat, as data. It says which coat look and which two palette names to use, and nothing
 * about how to draw them, so a flat drawing today and a 3D model later can read the same record.
 *
 * The stored coat is model output and untrusted. Free text is only ever searched for fixed colour words; what
 * comes out is a pattern and two palette names from the tables below, never a piece of the input.
 */

export const FUR = {
  ginger: "#e8a15a",
  black: "#2f3438",
  white: "#f6f3ee",
  grey: "#9aa3aa",
  cream: "#efd9b0",
  brown: "#8a6244",
  silver: "#cfd6da",
} as const;
export type FurKey = keyof typeof FUR;

export const AVATAR_PATTERNS = ["tabby", "solid", "tuxedo", "calico", "tortoiseshell", "bicolour", "unknown"] as const;
export type AvatarPattern = (typeof AVATAR_PATTERNS)[number];

export type Avatar = { pattern: AvatarPattern; base: FurKey; accent: FurKey };

/** The cat shown until a real one is ready, and for any coat we cannot read. */
export const NEUTRAL_AVATAR: Avatar = { pattern: "unknown", base: "grey", accent: "cream" };

const PATTERN_OF: Record<string, AvatarPattern> = {
  tabby: "tabby",
  solid: "solid",
  tuxedo: "tuxedo",
  calico: "calico",
  tortoiseshell: "tortoiseshell",
  bicolor: "bicolour",
  bicolour: "bicolour",
};

// Searched in order within one colour word, so "gray" is not caught by a shorter word first.
const WORDS: [RegExp, FurKey][] = [
  [/orange|ginger|marmalade|red|rust|yellow|apricot/, "ginger"],
  [/black|charcoal|ebony|jet/, "black"],
  [/white|snow/, "white"],
  [/silver/, "silver"],
  [/gr[ae]y|blue|ash|slate/, "grey"],
  [/cream|buff|beige|tan|sand|fawn/, "cream"],
  [/brown|chocolate|chestnut|tortoise|dark/, "brown"],
];

function furOf(word: unknown): FurKey | null {
  if (typeof word !== "string") return null;
  const w = word.toLowerCase().slice(0, 40);
  for (const [re, key] of WORDS) if (re.test(w)) return key;
  return null;
}

function coloursOf(coat: unknown): FurKey[] {
  const colors = (coat as { colors?: unknown } | null)?.colors;
  if (!Array.isArray(colors)) return [];
  const out: FurKey[] = [];
  for (const c of colors.slice(0, 4)) {
    const k = furOf(c);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** A partner colour that reads well beside the base. */
const PARTNER: Record<FurKey, FurKey> = {
  ginger: "brown",
  black: "grey",
  white: "grey",
  grey: "silver",
  cream: "brown",
  brown: "ginger",
  silver: "grey",
};

const other = (base: FurKey, wanted: FurKey): FurKey => (wanted === base ? PARTNER[base] : wanted);

/** Free text to a pattern and palette. Same input, same cat. */
export function catAvatar(coat: unknown, coatPattern: unknown): Avatar {
  const pattern = typeof coatPattern === "string" ? PATTERN_OF[coatPattern] : undefined;
  if (!pattern) return NEUTRAL_AVATAR;
  const found = coloursOf(coat);
  const nonWhite = found.filter((c) => c !== "white");
  switch (pattern) {
    case "tuxedo":
      return { pattern, base: found.find((c) => c === "black" || c === "grey" || c === "brown") ?? "black", accent: "white" };
    case "bicolour": {
      const base = nonWhite[0] ?? "grey";
      return { pattern, base, accent: "white" };
    }
    case "calico": {
      const base = nonWhite[0] ?? "ginger";
      return { pattern, base, accent: other(base, nonWhite[1] ?? "black") };
    }
    case "tortoiseshell": {
      const base = nonWhite[0] ?? "black";
      return { pattern, base, accent: other(base, nonWhite[1] ?? "ginger") };
    }
    case "tabby": {
      const base = found[0] ?? "brown";
      return { pattern, base, accent: other(base, found[1] ?? PARTNER[base]) };
    }
    default: {
      const base = found[0] ?? "grey";
      return { pattern, base, accent: PARTNER[base] };
    }
  }
}

const isFur = (v: unknown): v is FurKey => typeof v === "string" && Object.hasOwn(FUR, v);
const isPattern = (v: unknown): v is AvatarPattern => typeof v === "string" && (AVATAR_PATTERNS as readonly string[]).includes(v);

/** Reads a stored avatar. Anything outside the fixed tables is refused, and extra keys are dropped. */
export function parseAvatar(v: unknown): Avatar | null {
  if (typeof v !== "object" || v === null) return null;
  const { pattern, base, accent } = v as Record<string, unknown>;
  if (!isPattern(pattern) || !isFur(base) || !isFur(accent)) return null;
  return { pattern, base, accent };
}
