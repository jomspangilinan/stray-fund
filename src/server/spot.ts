import { and, asc, desc, eq, like, lt, or, sql } from "drizzle-orm";
import { COLONY } from "@/lib/config";
import { assessPhoto, type Assessment } from "./ai/assess";
import { AssessmentSchema } from "./ai/schemas";
import { matchCat } from "./ai/match";
import { db, type Tx } from "./db/client";
import { cats, guardrails, sightings } from "./db/schema";
import { transitionCat } from "./catTransitions";
import { fuzzLocation } from "./location";
import { publishScrubbed, storeOriginal, type Box } from "./photos";
import { getStorage } from "./storage";
import { enqueueWakeup } from "./wakeups";

export type Sex = "female" | "male" | "unknown";
export type SpotState = "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";
export type SpotResult = { state: SpotState; catId?: string; sightingId: string; message: string };

export const RATE_LIMIT_PER_MINUTE = 10;
export const RETRY_AFTER_SECONDS = 60;
export const RETRY_BATCH = 10;
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

const MESSAGES: Record<SpotState, string> = {
  new_cat: "Thanks for spotting! We started a card for this cat.",
  matched: "Thanks for spotting! We added your photo to their card.",
  needs_review: "Thanks for spotting! A caretaker will take a look.",
  rejected:
    "Thanks for trying! We could not see a cat clearly. Try again a little closer, in good light.",
  queued_for_ai: "Saved. We'll finish this soon.",
};

function result(state: SpotState, sightingId: string, catId?: string | null): SpotResult {
  return catId ? { state, catId, sightingId, message: MESSAGES[state] } : { state, sightingId, message: MESSAGES[state] };
}

type SightingRow = typeof sightings.$inferSelect;

function resultOf(s: SightingRow): SpotResult {
  const state: SpotState = s.state === "pending" ? "queued_for_ai" : (s.state as SpotState);
  return result(state, s.id, s.catId);
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
  sex?: Sex;
}): Promise<SpotResult> {
  await assertUnderRateLimit(i.userId);
  const { key } = await storeOriginal(i.jpeg);
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
        requestedSex: i.sex ?? null,
      })
      .returning({ id: sightings.id });
    return row;
  });

  return finishSighting(sighting.id);
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
    const res = await assessPhoto(original);
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
  const [row] = await db
    .update(sightings)
    .set({
      state: "needs_review",
      ...(assessment ? { assessment: { ...assessment, review_reason: "ai_unusable", candidate_cat_ids: candidateIds } } : {}),
    })
    .where(and(eq(sightings.id, sightingId), eq(sightings.state, "pending")))
    .returning();
  if (row) return resultOf(row);
  const [now] = await db.select().from(sightings).where(eq(sightings.id, sightingId));
  return resultOf(now);
}

const FLAG_NAMES = ["kitten", "pregnant", "injured", "sick"] as const;
const flagsOf = (a: Assessment) => FLAG_NAMES.filter((f) => a.flags[f]);

function cleanName(raw: string): string {
  const name = raw
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
  return name || FALLBACK_NAME;
}

async function uniqueName(tx: Tx, base: string): Promise<string> {
  const escaped = base.replace(/[\\%_]/g, "\\$&");
  const rows = await tx
    .select({ name: cats.name })
    .from(cats)
    .where(or(sql`lower(${cats.name}) = lower(${base})`, like(sql`lower(${cats.name})`, `${escaped.toLowerCase()} %`)));
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Applies the AI outcome to a pending sighting in one transaction. Conditional on state `pending`, so a
 * second call for the same sighting changes nothing and returns the first outcome.
 */
export async function applyAssessment(sightingId: string, a: Assessment, m: MatchOutcome): Promise<SpotResult> {
  const outcome = await db.transaction(async (tx) => {
    const [s] = await tx.select().from(sightings).where(eq(sightings.id, sightingId)).for("update");
    if (!s) throw new Error(`Sighting not found: ${sightingId}`);
    if (s.state !== "pending") return { done: false as const, result: resultOf(s), sighting: s };

    const [limits] = await tx.select().from(guardrails).where(eq(guardrails.id, 1));
    if (!limits) throw new Error("Guardrails row is missing");
    const earConfident = a.ear_tip !== "unknown" && a.ear_tip_confidence >= limits.earTipConfidenceMin;

    if (!a.is_cat || a.cat_visible_quality === "poor") {
      await tx.update(sightings).set({ state: "rejected", assessment: a }).where(eq(sightings.id, s.id));
      return { done: true as const, result: result("rejected", s.id), sighting: s, catId: null };
    }

    let matchedCat: typeof cats.$inferSelect | undefined;
    if (m.catId) {
      [matchedCat] = await tx.select().from(cats).where(eq(cats.id, m.catId)).for("update");
    }

    if (matchedCat && m.confidence >= limits.matchConfidenceMin) {
      const cat = matchedCat;
      let review = false;
      if (earConfident) {
        if (cat.status === "spotted" && cat.earTipped === null) {
          await resolveEarTip(tx, cat.id, a.ear_tip === "present");
        } else if (cat.status !== "spotted" && a.ear_tip === "present" && cat.earTipped !== true) {
          // Money may be moving for this cat, so a person decides.
          review = true;
        }
      }
      const flags = [...new Set([...cat.flags, ...flagsOf(a)])];
      if (flags.length !== cat.flags.length) await tx.update(cats).set({ flags }).where(eq(cats.id, cat.id));
      const stored = review ? { ...a, review_reason: "ear_tip_changed" } : a;
      await tx
        .update(sightings)
        .set({ catId: cat.id, state: review ? "needs_review" : "matched", matchConfidence: m.confidence, assessment: stored })
        .where(eq(sightings.id, s.id));
      return { done: true as const, result: result(review ? "needs_review" : "matched", s.id, cat.id), sighting: s, catId: cat.id };
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
      return { done: true as const, result: result("needs_review", s.id), sighting: s, catId: null };
    }

    const cat = await insertNewCat(tx, s, a);
    if (earConfident) await resolveEarTip(tx, cat.id, a.ear_tip === "present");
    const review = !earConfident;
    await tx
      .update(sightings)
      .set({
        catId: cat.id,
        state: review ? "needs_review" : "new_cat",
        matchConfidence: m.catId ? m.confidence : null,
        assessment: review ? { ...a, review_reason: "ear_tip" } : a,
      })
      .where(eq(sightings.id, s.id));
    return {
      done: true as const,
      result: result(review ? "needs_review" : "new_cat", s.id, cat.id),
      sighting: s,
      catId: cat.id,
    };
  });

  if (outcome.done && outcome.catId) {
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
  const sex: Sex =
    s.requestedSex === "female" || s.requestedSex === "male" || s.requestedSex === "unknown"
      ? s.requestedSex
      : a?.probably_female_by_coat
        ? "female"
        : "unknown";
  const [cat] = await tx
    .insert(cats)
    .values({
      name: await uniqueName(tx, cleanName(a?.suggested_name ?? "")),
      sex,
      flags: a ? flagsOf(a) : [],
      coat: a ? { colors: a.colors, markings: a.markings } : null,
      coatPattern: a?.coat_pattern ?? null,
      areaName: COLONY.area_name,
      exactLat: exact.lat,
      exactLng: exact.lng,
      fuzzedLat: fuzzed.lat,
      fuzzedLng: fuzzed.lng,
      locationApproximate: !hasPoint,
      bio: a?.short_bio.trim() || null,
    })
    .returning({ id: cats.id });
  return cat;
}

/** Ear-tipped cats are already neutered. Clean ears mean the cat joins the queue. */
export async function resolveEarTip(tx: Tx, catId: string, tipped: boolean): Promise<void> {
  if (tipped) {
    await tx.update(cats).set({ earTipped: true }).where(eq(cats.id, catId));
    await transitionCat(tx, catId, "neutered");
    return;
  }
  await tx.update(cats).set({ earTipped: false, queuedAt: new Date() }).where(eq(cats.id, catId));
  await transitionCat(tx, catId, "queued");
  await enqueueWakeup(tx, "cat_queued", { catId });
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
