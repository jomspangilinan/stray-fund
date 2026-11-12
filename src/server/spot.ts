import type { CatBox } from "@/lib/keepsake";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { catAvatar, NEUTRAL_AVATAR, parseAvatar, type Avatar } from "@/lib/avatar";
import { COLONY } from "@/lib/config";
import { assessPhoto, type Assessment } from "./ai/assess";
import { AssessmentSchema } from "./ai/schemas";
import { matchCat } from "./ai/match";
import { db, lockColony, type Tx } from "./db/client";
import { cats, guardrails, sightings } from "./db/schema";
import { catNamesInUse, uniqueName } from "./catNames";
import { autoPublishable } from "./photoGate";
import { nameIsSafe, safeBio } from "./placeText";
import { fuzzLocation } from "./location";
import { attachReports, filePhotoReports } from "./reports";
import { maskUsable, publishCatOnly, publishScrubbed, storeOriginal, type Box } from "./photos";
import { avatarFromPhoto } from "./photoAvatar";
import { getStorage } from "./storage";

export type Sex = "female" | "male" | "unknown";
export type SpotState = "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";
export type SpotResult = {
  state: SpotState;
  catId?: string;
  sightingId: string;
  message: string;
  /** The AI looked at this photo. False on the public path and while an AI run is still waiting. */
  aiChecked: boolean;
  /** The public cut-out is published. Only the public path reports this; the AI path leaves it false. */
  developed: boolean;
};

export const RATE_LIMIT_PER_MINUTE = 10;
export const RETRY_AFTER_SECONDS = 60;
export const RETRY_BATCH = 10;
export const PUBLIC_PHOTOS_PER_DAY = 5;
export const PUBLIC_NEW_CATS_PER_DAY = 50;
/** Below this a match is noise. From here up to the guardrail minimum it goes to a caretaker. */
export const MID_BAND_MIN = 0.5;
const MAX_CANDIDATES = 6;
const MAX_PHOTOS_PER_CANDIDATE = 3;
const FALLBACK_NAME = "Little stray";

export class RateLimited extends Error {
  constructor() {
    super("Too many photos in the last minute. Wait a moment and try again.");
    this.name = "RateLimited";
  }
}

export class DailyPhotoLimit extends Error {
  constructor(scope: "account" | "site") {
    super(
      scope === "account"
        ? `That's ${PUBLIC_PHOTOS_PER_DAY} photos today. Try again tomorrow.`
        : "The yard is full for today. Try again tomorrow.",
    );
    this.name = "DailyPhotoLimit";
  }
}

const PLAIN_MESSAGE = "Thanks for spotting! Your cat is in the yard.";

const REJECT_FALLBACK = "We couldn't use that photo. Try another one.";

const MESSAGES: Record<SpotState, string> = {
  new_cat: "Thanks for spotting! We started a card for this cat.",
  matched: "Thanks for spotting! We added your photo to their card.",
  needs_review: "Thanks for spotting! A caretaker will take a look.",
  rejected: REJECT_FALLBACK,
  queued_for_ai: "Saved. We'll finish this soon.",
};

const REJECT_MESSAGES: Record<string, string> = {
  screen_or_picture: "That looks like a screen or picture. We need a real cat.",
  no_cat: "We couldn't find a cat in that photo.",
  too_dark: "It's too dark to see the cat. Try somewhere brighter.",
  too_blurry: "The photo is blurry. Hold still and try again.",
  too_far: "The cat is too far away. Try a little closer.",
  cat_hidden: "We can't see enough of the cat. Try another angle.",
};

/** Only these fixed lines reach the visitor, never the AI's own text. A missing reason (an old row) reads as "none". */
function rejectedMessage(a: { reject_reason?: string } | null | undefined): string {
  return REJECT_MESSAGES[a?.reject_reason ?? "none"] ?? REJECT_FALLBACK;
}

function result(
  state: SpotState,
  sightingId: string,
  catId?: string | null,
  message = MESSAGES[state],
  extra: { aiChecked?: boolean; developed?: boolean } = {},
): SpotResult {
  const flags = { aiChecked: extra.aiChecked ?? state !== "queued_for_ai", developed: extra.developed ?? false };
  return catId ? { state, catId, sightingId, message, ...flags } : { state, sightingId, message, ...flags };
}

type SightingRow = typeof sightings.$inferSelect;

function resultOf(s: SightingRow): SpotResult {
  const state: SpotState = s.state === "pending" ? "queued_for_ai" : (s.state as SpotState);
  const message = s.needsDevelop ? PLAIN_MESSAGE : state === "rejected" ? rejectedMessage(s.assessment as { reject_reason?: string } | null) : undefined;
  return result(state, s.id, s.catId, message, {
    aiChecked: !s.needsDevelop && state !== "queued_for_ai",
    developed: s.needsDevelop ? s.developedAt !== null : false,
  });
}

export type MatchOutcome = { catId: string | null; confidence: number; candidateIds: string[] };

/** Per-user count of sightings in the last minute. Over the limit throws RateLimited. */
async function underRateLimit(tx: Pick<Tx, "execute">, userId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    select count(*)::int as n from sightings
    where caught_by_user_id = ${userId} and created_at > now() - interval '1 minute'
  `);
  return (rows[0] as { n: number }).n < RATE_LIMIT_PER_MINUTE;
}

export async function assertUnderRateLimit(userId: string): Promise<void> {
  if (!(await underRateLimit(db, userId))) throw new RateLimited();
}

export async function processSpot(i: {
  jpeg: Buffer;
  lat: number | null;
  lng: number | null;
  userId: string;
  /** Where the camera saw the cat, as fractions of the photo. Already validated by the caller. */
  box?: CatBox | null;
  /** True runs the AI on the photo (judges). False is the public path: no AI, and the photo is developed later. Defaults to true. */
  ai?: boolean;
  /** The phone's 64x64 cut-out of the cat, checked with maskUsable. Public path only. */
  mask?: Buffer | null;
}): Promise<SpotResult> {
  await assertUnderRateLimit(i.userId);
  const { key } = await storeOriginal(i.jpeg);
  if (i.ai === false) return processPlain(i, key);
  const hasPoint = i.lat !== null && i.lng !== null;

  // Commit the pending row first so nothing is lost if the AI step fails.
  const sighting = await db.transaction(async (tx) => {
    // Serialise one user's inserts so two requests cannot both slip under the limit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"spot:" + i.userId}))`);
    if (!(await underRateLimit(tx, i.userId))) throw new RateLimited();
    const [row] = await tx
      .insert(sightings)
      .values({
        originalKey: key,
        caughtByUserId: i.userId,
        takenAt: new Date(),
        state: "pending",
        exactLat: hasPoint ? i.lat : null,
        exactLng: hasPoint ? i.lng : null,
        catBox: i.box ?? null,
      })
      .returning({ id: sightings.id });
    return row;
  });

  return finishSighting(sighting.id);
}

/** Today's date in Manila, the day the public limits count in. */
const MANILA_DAY = sql`(now() at time zone 'Asia/Manila')::date`;
const MANILA_DAY_OF = (col: unknown) => sql`((${col}) at time zone 'Asia/Manila')::date`;

/**
 * The public path. No AI runs. The cat joins the yard at once with the neutral look-alike, and the photo is
 * published now when the phone sent a usable cut-out, otherwise it waits for the worker to develop it.
 */
async function processPlain(
  i: { jpeg: Buffer; lat: number | null; lng: number | null; userId: string; box?: CatBox | null; mask?: Buffer | null },
  originalKey: string,
): Promise<SpotResult> {
  const hasPoint = i.lat !== null && i.lng !== null;
  const { sighting, catId } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"spot:" + i.userId}))`);
    // One lock for the whole site, so two accounts cannot both take the last place of the day.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('spot:site-daily'))`);
    if (!(await underRateLimit(tx, i.userId))) throw new RateLimited();
    const { rows } = await tx.execute(sql`
      select
        count(*) filter (where caught_by_user_id = ${i.userId})::int as mine,
        count(*) filter (where needs_develop)::int as site
      from sightings where ${MANILA_DAY_OF(sql`created_at`)} = ${MANILA_DAY}
    `);
    const n = rows[0] as { mine: number; site: number };
    if (n.mine >= PUBLIC_PHOTOS_PER_DAY) throw new DailyPhotoLimit("account");
    if (n.site >= PUBLIC_NEW_CATS_PER_DAY) throw new DailyPhotoLimit("site");

    await lockColony(tx);
    const [row] = await tx
      .insert(sightings)
      .values({
        originalKey,
        caughtByUserId: i.userId,
        takenAt: new Date(),
        state: "new_cat",
        needsDevelop: true,
        exactLat: hasPoint ? i.lat : null,
        exactLng: hasPoint ? i.lng : null,
        catBox: i.box ?? null,
      })
      .returning();
    const cat = await insertNewCat(tx, row, null);
    await tx.update(sightings).set({ catId: cat.id }).where(eq(sightings.id, row.id));
    return { sighting: row, catId: cat.id };
  });

  const developed = await developNow(i, originalKey, sighting.id, catId);
  return result("new_cat", sighting.id, catId, PLAIN_MESSAGE, { aiChecked: false, developed });
}

/** The phone tier: a usable cut-out publishes at once. Anything else, or any failure, leaves the photo for the worker. */
async function developNow(
  i: { jpeg: Buffer; box?: CatBox | null; mask?: Buffer | null },
  originalKey: string,
  sightingId: string,
  catId: string,
): Promise<boolean> {
  const { box, mask } = i;
  if (!box || !mask || !(await maskUsable(mask, box))) return false;
  try {
    const { key } = await publishCatOnly(originalKey, { box, mask });
    const avatar = await avatarFromPhoto(i.jpeg, box);
    await db.transaction(async (tx) => {
      await tx
        .update(sightings)
        .set({ publicKey: key, publicReady: true, developedAt: new Date() })
        .where(and(eq(sightings.id, sightingId), sql`${sightings.developedAt} is null`));
      await tx.update(cats).set({ avatar }).where(eq(cats.id, catId));
    });
    return true;
  } catch (e) {
    console.error(`[spot] phone cut-out not published: ${e instanceof Error ? e.name : typeof e}`);
    return false;
  }
}

/** What the person who took a photo may poll: whether it is developed, the public copy, and their cat's look-alike. Null for anyone else's. */
export async function getSpotStatus(
  userId: string,
  sightingId: string,
): Promise<{ developed: boolean; photoUrl: string | null; avatar: Avatar } | null> {
  const [s] = await db
    .select({
      needsDevelop: sightings.needsDevelop,
      developedAt: sightings.developedAt,
      publicKey: sightings.publicKey,
      publicReady: sightings.publicReady,
      avatar: cats.avatar,
    })
    .from(sightings)
    .leftJoin(cats, eq(cats.id, sightings.catId))
    .where(and(eq(sightings.id, sightingId), eq(sightings.caughtByUserId, userId)));
  if (!s) return null;
  return {
    developed: s.needsDevelop ? s.developedAt !== null : s.publicReady,
    photoUrl: s.publicReady && s.publicKey ? getStorage().publicUrl(s.publicKey) : null,
    avatar: parseAvatar(s.avatar) ?? NEUTRAL_AVATAR,
  };
}

export async function finishSighting(sightingId: string): Promise<SpotResult> {
  return (await runSighting(sightingId)).result;
}

type Stop = "budget" | "unavailable";
type Run = { result: SpotResult; stop?: Stop };

/** Runs the AI steps for a pending sighting, with no database transaction open, then applies the outcome. */
async function runSighting(sightingId: string): Promise<Run> {
  const [s] = await db.select().from(sightings).where(eq(sightings.id, sightingId));
  if (!s) throw new Error(`Sighting not found: ${sightingId}`);
  if (s.state !== "pending") return { result: resultOf(s) };

  const original = await getStorage().getPrivate(s.originalKey);

  // A stored assessment on a pending row means an earlier run got this far. Do not pay for it twice.
  let assessment: Assessment;
  const stored = AssessmentSchema.safeParse(s.assessment);
  if (stored.success) {
    assessment = stored.data;
  } else {
    const res = await assessPhoto(original, await catNamesInUse(db));
    if (!res.ok) {
      if (res.reason === "budget" || res.reason === "unavailable") {
        return { result: result("queued_for_ai", s.id), stop: res.reason };
      }
      return { result: await markReview(s.id, null, []) };
    }
    assessment = res.data;
    await db
      .update(sightings)
      .set({ assessment })
      .where(and(eq(sightings.id, s.id), eq(sightings.state, "pending")));
  }

  if (!assessment.is_cat || assessment.cat_visible_quality === "poor") {
    return { result: await applyAssessment(s.id, assessment, { catId: null, confidence: 0, candidateIds: [] }) };
  }

  const candidates = await loadCandidates(assessment.coat_pattern);
  const candidateIds = candidates.map((c) => c.catId);
  if (candidates.length === 0) {
    return { result: await applyAssessment(s.id, assessment, { catId: null, confidence: 0, candidateIds }) };
  }

  const m = await matchCat(original, candidates);
  if (!m.ok) {
    if (m.reason === "budget" || m.reason === "unavailable") {
      return { result: result("queued_for_ai", s.id), stop: m.reason };
    }
    return { result: await markReview(s.id, assessment, candidateIds) };
  }
  return {
    result: await applyAssessment(s.id, assessment, {
      catId: m.data.match_cat_id,
      confidence: m.data.confidence,
      candidateIds,
    }),
  };
}

/** Same coat pattern, newest six cats. Reference photos are the private originals, newest first, at most three. */
async function loadCandidates(coatPattern: string): Promise<{ catId: string; photos: Buffer[] }[]> {
  const rows = await db
    .select({ id: cats.id })
    .from(cats)
    .where(eq(cats.coatPattern, coatPattern))
    .orderBy(desc(cats.createdAt))
    .limit(MAX_CANDIDATES);
  const storage = getStorage();
  const out: { catId: string; photos: Buffer[] }[] = [];
  for (const { id } of rows) {
    const shots = await db
      .select({ key: sightings.originalKey })
      .from(sightings)
      .where(eq(sightings.catId, id))
      .orderBy(desc(sightings.createdAt))
      .limit(MAX_PHOTOS_PER_CANDIDATE);
    const photos: Buffer[] = [];
    for (const { key } of shots) {
      try {
        photos.push(await storage.getPrivate(key));
      } catch {
        // A missing reference photo only makes this candidate weaker.
      }
    }
    out.push({ catId: id, photos });
  }
  return out;
}

/** The AI refused or returned nothing usable. A person decides; no cat is made. */
async function markReview(sightingId: string, assessment: Assessment | null, candidateIds: string[]): Promise<SpotResult> {
  const row = await db.transaction(async (tx) => {
    await lockColony(tx);
    const [moved] = await tx
      .update(sightings)
      .set({
        state: "needs_review",
        ...(assessment ? { assessment: { ...assessment, review_reason: "ai_unusable", candidate_cat_ids: candidateIds } } : {}),
      })
      .where(and(eq(sightings.id, sightingId), eq(sightings.state, "pending")))
      .returning();
    // Only the run that moved the sighting files its claims. No cat yet, so they wait for a caretaker.
    if (moved && assessment) await filePhotoReports(tx, moved.id, null, claimsOf(assessment));
    return moved;
  });
  if (row) return resultOf(row);
  const [now] = await db.select().from(sightings).where(eq(sightings.id, sightingId));
  return resultOf(now);
}

// The photo's guess of hurt, pregnant or sick is only a claim, filed as a report. cats.flags holds confirmed facts,
// and a kitten is the one guess a photo can state as fact.
const REPORT_FLAGS = ["pregnant", "injured", "sick"] as const;
const claimsOf = (a: Assessment) => REPORT_FLAGS.filter((f) => a.flags[f]);
const flagsOf = (a: Assessment): string[] => (a.flags.kitten ? ["kitten"] : []);

function cleanName(raw: string): string {
  const name = raw
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
  return name && nameIsSafe(name) ? name : FALLBACK_NAME;
}

/**
 * Applies the AI outcome to a pending sighting in one transaction. Conditional on state `pending`, so a
 * second call for the same sighting changes nothing and returns the first outcome.
 */
export async function applyAssessment(sightingId: string, a: Assessment, m: MatchOutcome): Promise<SpotResult> {
  const outcome = await db.transaction(async (tx) => {
    // Colony lock first, like every other path that changes a cat.
    await lockColony(tx);
    const [s] = await tx.select().from(sightings).where(eq(sightings.id, sightingId)).for("update");
    if (!s) throw new Error(`Sighting not found: ${sightingId}`);
    if (s.state !== "pending") return { done: false as const, result: resultOf(s), sighting: s };

    const [limits] = await tx.select().from(guardrails).where(eq(guardrails.id, 1));
    if (!limits) throw new Error("Guardrails row is missing");

    if (!a.is_cat || a.cat_visible_quality === "poor") {
      await tx.update(sightings).set({ state: "rejected", assessment: a }).where(eq(sightings.id, s.id));
      return { done: true as const, result: result("rejected", s.id, null, rejectedMessage(a)), sighting: s, catId: null };
    }

    let matchedCat: typeof cats.$inferSelect | undefined;
    if (m.catId) {
      [matchedCat] = await tx.select().from(cats).where(eq(cats.id, m.catId)).for("update");
    }

    if (matchedCat && m.confidence >= limits.matchConfidenceMin) {
      const cat = matchedCat;
      const flags = [...new Set([...cat.flags, ...flagsOf(a)])];
      if (flags.length !== cat.flags.length) await tx.update(cats).set({ flags }).where(eq(cats.id, cat.id));
      await tx
        .update(sightings)
        .set({ catId: cat.id, state: "matched", matchConfidence: m.confidence, assessment: a })
        .where(eq(sightings.id, s.id));
      // A neighbour may have reported this photo while it waited for the AI. Their report attaches first, so it stands
      // and the photo's own guess of the same claim files nothing.
      await attachReports(tx, s.id, cat.id);
      await filePhotoReports(tx, s.id, cat.id, claimsOf(a));
      return { done: true as const, result: result("matched", s.id, cat.id), sighting: s, catId: cat.id };
    }

    if (matchedCat && m.confidence >= MID_BAND_MIN) {
      const ids = [matchedCat.id, ...m.candidateIds.filter((id) => id !== matchedCat.id)];
      await tx
        .update(sightings)
        .set({
          state: "needs_review",
          matchConfidence: m.confidence,
          assessment: { ...a, review_reason: "possible_match", candidate_cat_ids: ids },
        })
        .where(eq(sightings.id, s.id));
      // No cat yet. The report waits and attaches when a caretaker sorts the photo.
      await filePhotoReports(tx, s.id, null, claimsOf(a));
      return { done: true as const, result: result("needs_review", s.id), sighting: s, catId: null };
    }

    const cat = await insertNewCat(tx, s, a);
    await tx
      .update(sightings)
      .set({ catId: cat.id, state: "new_cat", matchConfidence: m.catId ? m.confidence : null, assessment: a })
      .where(eq(sightings.id, s.id));
    await attachReports(tx, s.id, cat.id);
    await filePhotoReports(tx, s.id, cat.id, claimsOf(a));
    return { done: true as const, result: result("new_cat", s.id, cat.id), sighting: s, catId: cat.id };
  });

  // Only a photo the model vouches for goes public by itself. Otherwise it waits in the caretaker's held photos.
  if (outcome.done && outcome.catId && autoPublishable(a)) {
    await publishPhoto(outcome.sighting.id, outcome.sighting.originalKey, a.sensitive_regions);
  }
  return outcome.result;
}

/**
 * A new cat from a sighting. The fuzz is computed here, once, and never again. A caretaker
 * confirming a sighting the AI could not settle passes no assessment and gets plain defaults.
 */
export async function insertNewCat(tx: Tx, s: SightingRow, a: Assessment | null): Promise<{ id: string }> {
  const hasPoint = s.exactLat !== null && s.exactLng !== null;
  const exact = hasPoint ? { lat: s.exactLat!, lng: s.exactLng! } : COLONY.centre;
  const fuzzed = fuzzLocation(exact.lat, exact.lng);
  // Only the server's own coat rule sets a sex here. The finder answers afterwards, on the reveal or the card.
  const sex: Sex = a?.probably_female_by_coat ? "female" : "unknown";
  const name = await uniqueName(tx, cleanName(a?.suggested_name ?? ""));
  const [cat] = await tx
    .insert(cats)
    .values({
      name,
      sex,
      flags: a ? flagsOf(a) : [],
      coat: a ? { colors: a.colors, markings: a.markings } : null,
      coatPattern: a?.coat_pattern ?? null,
      avatar: a ? catAvatar({ colors: a.colors, markings: a.markings }, a.coat_pattern) : null,
      areaName: COLONY.area_name,
      exactLat: exact.lat,
      exactLng: exact.lng,
      fuzzedLat: fuzzed.lat,
      fuzzedLng: fuzzed.lng,
      locationApproximate: !hasPoint,
      bio: a ? safeBio(a.short_bio, name) : null,
    })
    .returning({ id: cats.id });
  return cat;
}

/** Only an assessment that listed its sensitive regions (even none) makes a photo public. Never fails the spot. */
export async function publishPhoto(sightingId: string, originalKey: string, regions: unknown): Promise<void> {
  if (!Array.isArray(regions)) return;
  try {
    const { key } = await publishScrubbed(originalKey, regions as Box[]);
    await db
      .update(sightings)
      .set({ publicKey: key, publicReady: true })
      .where(and(eq(sightings.id, sightingId), sql`${sightings.publicKey} is null`));
  } catch (e) {
    // Class name only: errors from storage can carry keys.
    console.error(`[spot] could not publish photo: ${e instanceof Error ? e.name : typeof e}`);
  }
}

export type RetrySummary = { examined: number; completed: number; stopped?: Stop };

/**
 * Finishes pending sightings older than a minute, oldest first, up to ten. One failure does not stop the
 * rest, but a budget or outage report ends the run so the worker does not hammer the AI.
 */
export async function retryPendingSightings(): Promise<RetrySummary> {
  const rows = await db
    .select({ id: sightings.id })
    .from(sightings)
    .where(and(eq(sightings.state, "pending"), lt(sightings.createdAt, sql`now() - make_interval(secs => ${RETRY_AFTER_SECONDS})`)))
    .orderBy(asc(sightings.createdAt))
    .limit(RETRY_BATCH);
  const summary: RetrySummary = { examined: 0, completed: 0 };
  for (const { id } of rows) {
    summary.examined++;
    try {
      const run = await runSighting(id);
      if (run.stop) {
        summary.stopped = run.stop;
        break;
      }
      if (run.result.state !== "queued_for_ai") summary.completed++;
    } catch (e) {
      console.error(`[spot] retry failed: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
  return summary;
}
