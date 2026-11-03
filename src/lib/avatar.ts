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

export const AVATAR_PATTERNS = [
  "tabby",
  "solid",
  "tuxedo",
  "calico",
  "tortoiseshell",
  "bicolour",
  "patched",
  "cap",
  "colourpoint",
  "unknown",
] as const;
export type AvatarPattern = (typeof AVATAR_PATTERNS)[number];

/** The ribbon a girl wears: one fixed blue with a white edge, so it reads on every coat and is far from the collar red. */
export const RIBBON = "#1c4aa0";
export const RIBBON_EDGE = FUR.white;

export type Avatar = { pattern: AvatarPattern; base: FurKey; accent: FurKey };

/** The cat shown until a real one is ready, and for any coat we cannot read. */
export const NEUTRAL_AVATAR: Avatar = { pattern: "unknown", base: "grey", accent: "cream" };

/** FNV-1a, so the same id always gives the same number. */
export function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/*
 * Small per-cat details. They come from the cat's id alone and are never stored, so a cat always looks the
 * same and no text can reach them. The drawing reads only these fixed names.
 */
export const EYE = { amber: "#e0b02a", green: "#8bb85a", blue: "#79acd6" } as const;
export type EyeKey = keyof typeof EYE;
export const TAILS = ["plain", "tip", "kinked"] as const;
export type TailKey = (typeof TAILS)[number];
export const FACES = ["none", "blaze", "cheek"] as const;
export type FaceKey = (typeof FACES)[number];

export type CatDetails = {
  eyes: EyeKey;
  tail: TailKey;
  face: FaceKey;
  /** Which of three patch layouts a patched, calico or tortoiseshell cat wears. */
  layout: 0 | 1 | 2;
  /** Mirrors patches and the cheek mark left to right. */
  flip: boolean;
};

const EYE_PICK: EyeKey[] = ["amber", "green", "amber", "green", "amber", "blue"];
const TAIL_PICK: TailKey[] = ["plain", "plain", "plain", "tip", "tip", "kinked"];
const FACE_PICK: FaceKey[] = ["none", "none", "blaze", "cheek"];

/** The details of one cat, picked from its id. Same id, same details. */
export function catDetails(id: string, pattern: AvatarPattern): CatDetails {
  const pick = <T,>(salt: string, from: readonly T[]): T => from[hashOf(`${id}:${salt}`) % from.length];
  const face = pick("face", FACE_PICK);
  return {
    eyes: pattern === "colourpoint" ? "blue" : pick("eyes", EYE_PICK),
    tail: pick("tail", TAIL_PICK),
    // Only coats with a plain face carry a face mark; the rest already have their own.
    face: pattern === "solid" ? face : pattern === "bicolour" || pattern === "patched" ? (face === "blaze" ? "cheek" : face) : "none",
    layout: (hashOf(`${id}:layout`) % 3) as 0 | 1 | 2,
    flip: hashOf(`${id}:flip`) % 2 === 1,
  };
}

const PATTERN_OF: Record<string, AvatarPattern> = {
  tabby: "tabby",
  solid: "solid",
  tuxedo: "tuxedo",
  calico: "calico",
  tortoiseshell: "tortoiseshell",
  bicolor: "bicolour",
  bicolour: "bicolour",
  colorpoint: "colourpoint",
  colourpoint: "colourpoint",
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

function markingsOf(coat: unknown): string {
  const m = (coat as { markings?: unknown } | null)?.markings;
  return typeof m === "string" ? m.toLowerCase().slice(0, 200) : "";
}

// Words that say the cat is mostly white, or mostly dark, in the AI's own markings note. Searched, never copied.
const MOSTLY_WHITE = /(mostly|mainly|largely|predominantly|primarily) white|white (cat|body|coat)|white with/;
const MOSTLY_DARK = /(mostly|mainly|largely|predominantly|primarily) (black|dark|gr[ae]y|brown|orange|ginger)|(black|dark) (cat|body|coat) with/;
const CAP_WORDS = /\b(cap|mask|hood|helmet|hat)\b/;

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
      const note = markingsOf(coat);
      const whiteLed = !MOSTLY_DARK.test(note) && (found[0] === "white" || MOSTLY_WHITE.test(note));
      const dark = nonWhite.find((c) => c !== "cream") ?? nonWhite[0] ?? "black";
      // A white cat with a coloured cap on the head, or with patches scattered over it.
      if (whiteLed && CAP_WORDS.test(note)) return { pattern: "cap", base: "white", accent: dark };
      if (whiteLed) return { pattern: "patched", base: "white", accent: dark };
      return { pattern, base: nonWhite[0] ?? "grey", accent: "white" };
    }
    case "colourpoint": {
      const base = found.find((c) => c === "white" || c === "cream" || c === "silver") ?? "cream";
      const point = found.find((c) => c === "brown" || c === "black" || c === "grey" || c === "ginger");
      return { pattern, base, accent: point ?? "brown" };
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
