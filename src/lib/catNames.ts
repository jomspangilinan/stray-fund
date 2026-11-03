/** Kind, simple Filipino cat names. A free one from here is used when the AI picks a taken name, and for Another name. */
export const CAT_NAMES: readonly string[] = [
  "Muning",
  "Mingming",
  "Tigre",
  "Kuting",
  "Pepita",
  "Kiko",
  "Mimi",
  "Mocha",
  "Biscoy",
  "Sinta",
  "Tala",
  "Luna",
  "Ningning",
  "Tsokolate",
  "Kape",
  "Gatas",
  "Mani",
  "Mangga",
  "Suman",
  "Bibingka",
  "Puto",
  "Halo",
  "Ube",
  "Pandesal",
  "Biko",
  "Turon",
  "Siopao",
  "Tokwa",
  "Pancit",
  "Lumpia",
  "Kutsinta",
  "Malou",
  "Nene",
  "Tinay",
  "Maya",
  "Mayang",
  "Tisay",
  "Kulot",
  "Puting",
  "Itim",
  "Bulaklak",
  "Sampaguita",
  "Rosal",
  "Dahlia",
  "Ligaya",
  "Saya",
  "Ginto",
  "Pilak",
  "Perlas",
  "Diwa",
  "Araw",
  "Buwan",
  "Ulap",
  "Hangin",
  "Alon",
  "Bato",
  "Dahon",
  "Kidlat",
  "Bagwis",
  "Lambing",
  "Galing",
  "Bunso",
  "Chikoy",
  "Dodong",
  "Inday",
  "Lando",
  "Pining",
  "Tonyo",
  "Nonoy",
  "Neneng",
  "Bebang",
  "Choleng",
  "Pilar",
];

const NAME_MAX = 30;
const NAME_SHAPE = /^[\p{L}\p{M}' ’-]+$/u;

export type ParsedName = { ok: true; name: string } | { ok: false; message: string };

/**
 * Trimmed, 1 to 30 characters, letters from any language with their marks, single spaces, hyphens and
 * apostrophes only. Used by the card, the routes and the caretaker desk, so every door has one rule.
 */
export function parseCatName(raw: unknown): ParsedName {
  const name = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  if (!name) return { ok: false, message: "Type a name." };
  if ([...name].length > NAME_MAX) return { ok: false, message: `Use ${NAME_MAX} characters or fewer.` };
  if (!NAME_SHAPE.test(name) || !/\p{L}/u.test(name)) {
    return { ok: false, message: "Use letters, spaces, hyphens and apostrophes only." };
  }
  return { ok: true, name };
}

/**
 * A name nobody holds. `taken` is lower case. A random free name from the list; only when the whole list is
 * used does a number follow a list name.
 */
export function pickFreeName(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const free = CAT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(random() * free.length) % free.length];
  const base = CAT_NAMES[Math.floor(random() * CAT_NAMES.length) % CAT_NAMES.length];
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
