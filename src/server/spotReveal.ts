import { eq } from "drizzle-orm";
import { NEUTRAL_AVATAR, parseAvatar, type Avatar } from "@/lib/avatar";
import { db } from "./db/client";
import { cats, sightings } from "./db/schema";
import { ownFlags, type EarTipValue } from "./earTipFlags";
import { FLAG_LABEL, STATUS_LABEL } from "./public";
import { getStorage } from "./storage";
import type { SpotState } from "./spot";

/*
 * What the spot response may say about the cat. Built field by field, like every public shape: no
 * coordinates, keys, assessment text or confidence numbers can ride along. The photo is the scrubbed public
 * copy and only once it is ready; otherwise the screen keeps the picture the person just took.
 */

export type SpotReveal = {
  /** Only seeds the small details of the look-alike, so it draws the same as in the yard. */
  catId: string | null;
  name: string | null;
  /** The look-alike that arrives in the yard. Fixed palette only; the neutral cat until the real one is ready. */
  avatar: Avatar | null;
  coat: string | null;
  /** What this person said about the ear tip, if they said. Their own answer, never a finding. */
  yourEarTip: EarTipValue | null;
  flags: string[];
  statusLabel: string;
  /** Only when the server's own coat rule set the sex, never when the finder chose it. */
  probablyFemale: boolean;
  /** The cat is waiting in the queue for the shared pool. */
  needsFunding: boolean;
  photoUrl: string | null;
};

export type RevealInput = {
  state: SpotState;
  /** The finder's own flag on this cat. */
  yourEarTip?: EarTipValue | null;
  cat: {
    id: string;
    name: string;
    status: string;
    sex: string;
    coatPattern: string | null;
    /** As stored, untrusted: read through parseAvatar. */
    avatar: unknown;
    flags: string[];
  } | null;
  sighting: {
    publicKey: string | null;
    publicReady: boolean;
    requestedSex: string | null;
    /** The assessment said a clear calico or tortoiseshell coat. */
    coatSaysFemale: boolean;
  };
};

const COAT_LABEL: Record<string, string> = {
  solid: "Solid coat",
  tabby: "Tabby",
  bicolor: "Bicolour",
  tuxedo: "Tuxedo",
  calico: "Calico",
  tortoiseshell: "Tortoiseshell",
  colorpoint: "Colourpoint",
  other: "Mixed coat",
};

const SEXES = new Set(["female", "male", "unknown"]);

export function buildReveal(i: RevealInput): SpotReveal | null {
  if (i.state === "needs_review") {
    // A person decides, so nothing about the cat is stated.
    return {
      catId: null,
      name: null,
      avatar: null,
      coat: null,
      yourEarTip: null,
      flags: [],
      statusLabel: "Waiting for a caretaker",
      probablyFemale: false,
      needsFunding: false,
      photoUrl: null,
    };
  }
  if ((i.state !== "new_cat" && i.state !== "matched") || !i.cat) return null;
  const { cat, sighting } = i;
  const finderChose = sighting.requestedSex !== null && SEXES.has(sighting.requestedSex);
  return {
    catId: cat.id,
    name: cat.name,
    avatar: parseAvatar(cat.avatar) ?? NEUTRAL_AVATAR,
    coat: cat.coatPattern ? (COAT_LABEL[cat.coatPattern] ?? null) : null,
    yourEarTip: i.yourEarTip ?? null,
    flags: cat.flags.map((f) => FLAG_LABEL[f]).filter((f): f is string => Boolean(f)),
    statusLabel: STATUS_LABEL[cat.status] ?? cat.status,
    probablyFemale: i.state === "new_cat" && !finderChose && sighting.coatSaysFemale && cat.sex === "female",
    needsFunding: cat.status === "queued",
    photoUrl: sighting.publicReady && sighting.publicKey ? getStorage().publicUrl(sighting.publicKey) : null,
  };
}

/** Reads the finished sighting and its cat, then lets buildReveal decide what may be said. */
export async function loadReveal(sightingId: string, state: SpotState): Promise<SpotReveal | null> {
  if (state !== "new_cat" && state !== "matched" && state !== "needs_review") return null;
  const [s] = await db
    .select({
      catId: sightings.catId,
      publicKey: sightings.publicKey,
      publicReady: sightings.publicReady,
      requestedSex: sightings.requestedSex,
      assessment: sightings.assessment,
      finderId: sightings.caughtByUserId,
    })
    .from(sightings)
    .where(eq(sightings.id, sightingId));
  if (!s) return null;
  const [cat] = s.catId
    ? await db
        .select({
          id: cats.id,
          name: cats.name,
          status: cats.status,
          sex: cats.sex,
          coatPattern: cats.coatPattern,
          avatar: cats.avatar,
          flags: cats.flags,
        })
        .from(cats)
        .where(eq(cats.id, s.catId))
    : [];
  const yourEarTip = s.catId && s.finderId ? ((await ownFlags(db, s.finderId, [s.catId])).get(s.catId) ?? null) : null;
  const a = s.assessment as { probably_female_by_coat?: unknown } | null;
  return buildReveal({
    state,
    yourEarTip,
    cat: cat ?? null,
    sighting: {
      publicKey: s.publicKey,
      publicReady: s.publicReady,
      requestedSex: s.requestedSex,
      coatSaysFemale: a?.probably_female_by_coat === true,
    },
  });
}
