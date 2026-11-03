import { COLONY } from "@/lib/config";
import { isPlainText } from "./plainText";

/*
 * Words from the AI that end up on a public card must not carry a place. The model reads the photo, so a
 * sign, a shop or a gate number can end up in its sentence. This is the server's check, whatever the prompt says:
 * when a bio fails, the card gets the generic line, never the model's words.
 */

export const GENERIC_BIO = "A friendly neighbourhood cat.";

/** Words that point at a place. Whole words, any case. */
const PLACE_WORDS = [
  "street", "st", "road", "rd", "avenue", "ave", "boulevard", "blvd", "lane", "drive", "highway", "hwy", "alley", "corner",
  "barangay", "brgy", "purok", "sitio", "subdivision", "village", "district", "city", "town", "province", "compound", "block",
  "market", "mall", "store", "shop", "sari-sari", "supermarket", "pharmacy", "drugstore", "bakery", "restaurant", "cafe", "bank",
  "school", "church", "chapel", "hospital", "clinic", "plaza", "park", "terminal", "station", "building", "tower", "condo",
  "apartment", "house", "gate", "sign", "signboard", "billboard", "plate", "address", "number", "hall", "office", "factory",
  "warehouse", "jeepney", "tricycle", "near", "behind", "outside", "beside", "opposite", "across",
  "rizal", "mabini", "bonifacio", "quezon", "aguinaldo", "burgos", "luna", "magsaysay", "osmena", "roxas", "jollibee",
  "mcdonalds", "puregold", "robinsons", "ayala", "mercury", "watsons", "seveneleven", "lawson",
];

/** The colony's own area words, from the same config the card uses. */
function areaWords(): string[] {
  const text = `${COLONY.name} ${COLONY.area_name}`.toLowerCase();
  return [...new Set(text.match(/\p{L}+/gu) ?? [])].filter((w) => w.length > 3);
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/['’]/g, "").match(/[\p{L}]+(?:-[\p{L}]+)*/gu) ?? [];
}

function mentionsPlace(s: string): boolean {
  const bad = new Set([...PLACE_WORDS, ...areaWords()]);
  return tokens(s).some((w) => bad.has(w));
}

/** Capital letters in the middle of a sentence name something: a shop, a street, a sign. The cat's own name is fine. */
function hasStrayCapitals(s: string, catName: string): boolean {
  const own = new Set(tokens(catName));
  const sentences = s.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
    for (const [i, w] of words.entries()) {
      const capital = /^\p{Lu}/u.test(w) && w !== "I" && !/^I['’]/.test(w);
      if (!capital) continue;
      if (own.has(w.toLowerCase())) continue;
      if (i > 0) return true;
      if (w.length > 1 && w === w.toUpperCase()) return true;
    }
  }
  return false;
}

/** True when the sentence is only about the cat. */
export function bioIsSafe(bio: string, catName = ""): boolean {
  const s = bio.trim();
  if (!s || !isPlainText(s)) return false;
  if (/\p{N}/u.test(s)) return false;
  if (mentionsPlace(s)) return false;
  if (hasStrayCapitals(s, catName)) return false;
  return true;
}

/** The bio to publish: the model's sentence if it passes, else the generic line. */
export function safeBio(bio: string | null | undefined, catName = ""): string {
  const s = (bio ?? "").trim();
  return bioIsSafe(s, catName) ? s : GENERIC_BIO;
}

/** A name from the photo: no digit, no place word, no area name. */
export function nameIsSafe(name: string): boolean {
  return !/\p{N}/u.test(name) && !mentionsPlace(name);
}
