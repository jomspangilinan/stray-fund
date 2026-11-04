import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "./db/client";
import { agentActions, cats, reports, sightings, wakeups } from "./db/schema";
import { REPORT_CLEARED, REPORT_CONFIRMED, REPORT_DISMISSED, REPORT_FILED } from "./privateActions";
import { enqueueWakeup } from "./wakeups";

/*
 * A report is someone's claim that a cat is hurt, pregnant, sick or a kitten. It is private: the note is free text
 * and never goes public. Three claims hold a cat from funding, set by this code and not by the AI: hurt, pregnant
 * and sick. The hold starts when the report opens and ends when a caretaker dismisses it, or, for a confirmed
 * report, when a vet clears the cat for surgery. Only a confirmed claim reaches cats.flags, so nothing a
 * neighbour or a photo merely said can move the funding order.
 *
 * Every function takes the caller's transaction, and the caller holds the colony lock like every other path that
 * changes a cat.
 */

export type Claim = "injured" | "pregnant" | "sick" | "kitten";
export const CLAIMS: readonly Claim[] = ["injured", "pregnant", "sick", "kitten"];
/** The claims that keep a cat from funding until a person has checked. A kitten claim never does. */
export const HOLD_CLAIMS = ["injured", "pregnant", "sick"] as const;

export const REPORT_WAKEUP = "report_changed";
/** A new report wakes the treasurer for a cat at most this often. A confirm or dismiss always does. */
const WAKE_WINDOW_MINUTES = 15;

export type ReportRefusalReason = "sighting_required" | "already_today" | "dismissed_before";

/** A report that cannot be filed. The message is fixed text, so it is safe to show the person who filed. */
export class ReportRefused extends Error {
  constructor(readonly reason: ReportRefusalReason) {
    super(MESSAGES[reason]);
    this.name = "ReportRefused";
  }
}

const MESSAGES: Record<ReportRefusalReason, string> = {
  sighting_required: "A report needs a photo taken at the spot.",
  already_today: "You already reported this today. A caretaker will look.",
  dismissed_before: "A caretaker already checked this and did not find it.",
};

export type DecisionResult = { ok: true } | { ok: false; reason: "not_found" | "not_open" | "no_cat" };

const manilaToday = sql`(now() at time zone 'Asia/Manila')::date`;

type NeighbourOrPhoto = {
  /** Required: a finder's report is tied to the live photo from the spot flow. */
  sightingId: string;
  catId: string | null;
  claim: Claim;
  note: string | null;
  source: "neighbour" | "photo";
  reporterId: string | null;
};

async function audit(tx: Tx, action: string, reason: string, inputs: object, by: string | null): Promise<void> {
  // The note never goes in here. Inputs hold ids and the claim only.
  await tx.insert(agentActions).values({ action, inputs, reason, status: "done", approvedBy: by });
}

/** Queues a wakeup for the cat unless one is already pending from the last 15 minutes. */
async function wakeOnce(tx: Tx, catId: string): Promise<void> {
  const [pending] = await tx
    .select({ id: wakeups.id })
    .from(wakeups)
    .where(
      and(
        eq(wakeups.kind, REPORT_WAKEUP),
        eq(wakeups.status, "pending"),
        sql`${wakeups.payload}->>'catId' = ${catId}`,
        sql`${wakeups.createdAt} > now() - make_interval(mins => ${WAKE_WINDOW_MINUTES})`,
      ),
    )
    .limit(1);
  if (!pending) await enqueueWakeup(tx, REPORT_WAKEUP, { catId });
}

/**
 * A finder's or the photo's claim. Starts open and holds the cat at once. Refuses with ReportRefused when there is
 * no photo behind it, when the same person already made this claim on this cat today (Manila day), or when a
 * caretaker already dismissed this person's claim of it on this cat.
 */
export async function fileReport(tx: Tx, input: NeighbourOrPhoto): Promise<{ id: string }> {
  // Checked at runtime as well as in the types: callers pass request data through casts.
  if (typeof input.sightingId !== "string" || input.sightingId === "") throw new ReportRefused("sighting_required");
  const [sighting] = await tx
    .select({ assessment: sightings.assessment })
    .from(sightings)
    .where(eq(sightings.id, input.sightingId));
  if (!sighting) throw new ReportRefused("sighting_required");

  if (input.reporterId && input.catId) {
    const mine = and(eq(reports.catId, input.catId), eq(reports.reporterId, input.reporterId), eq(reports.claim, input.claim));
    const [dismissed] = await tx.select({ id: reports.id }).from(reports).where(and(mine, eq(reports.status, "dismissed"))).limit(1);
    if (dismissed) throw new ReportRefused("dismissed_before");
  }

  const flags = (sighting.assessment as { flags?: Record<string, unknown> } | null)?.flags;
  const photoAgrees = sighting.assessment == null ? null : flags?.[input.claim] === true;

  const [row] = await tx
    .insert(reports)
    .values({
      catId: input.catId,
      sightingId: input.sightingId,
      claim: input.claim,
      note: input.note,
      source: input.source,
      reporterId: input.reporterId,
      photoAgrees,
      reportedOn: manilaToday,
    })
    .onConflictDoNothing()
    .returning({ id: reports.id });
  if (!row) throw new ReportRefused("already_today");

  await audit(
    tx,
    REPORT_FILED,
    "A report was filed about a cat.",
    { reportId: row.id, catId: input.catId, sightingId: input.sightingId, claim: input.claim, source: input.source, reporterId: input.reporterId },
    null,
  );
  if (input.catId) await wakeOnce(tx, input.catId);
  return { id: row.id };
}

/**
 * The AI's photo guesses of hurt, pregnant or sick, filed as reports from "photo" with a neighbour's power. A claim
 * the cat already has confirmed, or already has open, is not filed again, so every new photo of a hurt cat does not
 * add a card to the desk. With no cat yet the report waits for attachReports.
 */
export async function filePhotoReports(tx: Tx, sightingId: string, catId: string | null, claims: readonly Claim[]): Promise<void> {
  const wanted = claims.filter((c) => (HOLD_CLAIMS as readonly string[]).includes(c));
  if (wanted.length === 0) return;
  let skip = new Set<string>();
  if (catId) {
    const [cat] = await tx.select({ flags: cats.flags }).from(cats).where(eq(cats.id, catId));
    const open = await tx
      .select({ claim: reports.claim })
      .from(reports)
      .where(and(eq(reports.catId, catId), eq(reports.status, "open")));
    skip = new Set([...(cat?.flags ?? []), ...open.map((r) => r.claim)]);
  }
  for (const claim of wanted) {
    if (skip.has(claim)) continue;
    await fileReport(tx, { sightingId, catId, claim, note: null, source: "photo", reporterId: null });
  }
}

/** Adds the claim to the cat's confirmed flags. */
async function addFlag(tx: Tx, catId: string, claim: Claim): Promise<void> {
  await tx
    .update(cats)
    .set({ flags: sql`case when ${claim} = any(${cats.flags}) then ${cats.flags} else array_append(${cats.flags}, ${claim}) end` })
    .where(eq(cats.id, catId));
}

/**
 * A caretaker's or vet's own word, which counts as a check. Confirmed at once, so the flag is set and the cat is
 * held until a vet clears it. Filing the same claim again on the same day returns the first report.
 */
export async function fileStaffReport(
  tx: Tx,
  input: { catId: string; claim: Claim; source: "caretaker" | "vet"; reporterId: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(reports)
    .values({
      catId: input.catId,
      claim: input.claim,
      source: input.source,
      reporterId: input.reporterId,
      status: "confirmed",
      decidedBy: input.reporterId,
      decidedAt: sql`now()`,
      reportedOn: manilaToday,
    })
    .onConflictDoNothing()
    .returning({ id: reports.id });
  if (!row) {
    const [first] = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.catId, input.catId), eq(reports.reporterId, input.reporterId), eq(reports.claim, input.claim), sql`${reports.reportedOn} = ${manilaToday}`));
    return { id: first.id };
  }
  await addFlag(tx, input.catId, input.claim);
  await audit(
    tx,
    REPORT_FILED,
    "A report was filed about a cat.",
    { reportId: row.id, catId: input.catId, claim: input.claim, source: input.source, reporterId: input.reporterId },
    input.reporterId,
  );
  await enqueueWakeup(tx, REPORT_WAKEUP, { catId: input.catId });
  return { id: row.id };
}

async function decide(tx: Tx, id: string, by: string, to: "confirmed" | "dismissed"): Promise<DecisionResult> {
  const [r] = await tx.select().from(reports).where(eq(reports.id, id)).for("update");
  if (!r) return { ok: false, reason: "not_found" };
  // A double tap lands here the second time and changes nothing.
  if (r.status !== "open") return { ok: false, reason: "not_open" };
  if (to === "confirmed" && !r.catId) return { ok: false, reason: "no_cat" };

  await tx.update(reports).set({ status: to, decidedBy: by, decidedAt: sql`now()` }).where(eq(reports.id, id));
  if (to === "confirmed" && r.catId) await addFlag(tx, r.catId, r.claim as Claim);
  await audit(
    tx,
    to === "confirmed" ? REPORT_CONFIRMED : REPORT_DISMISSED,
    to === "confirmed" ? "A caretaker confirmed a report." : "A caretaker dismissed a report.",
    { reportId: id, catId: r.catId, claim: r.claim },
    by,
  );
  if (r.catId) await enqueueWakeup(tx, REPORT_WAKEUP, { catId: r.catId });
  return { ok: true };
}

/** Confirms an open report: the claim becomes a flag on the cat, and the cat stays held until a vet clears it. */
export const confirmReport = (tx: Tx, id: string, caretakerId: string) => decide(tx, id, caretakerId, "confirmed");

/** Dismisses an open report and ends its hold. The flags are untouched. */
export const dismissReport = (tx: Tx, id: string, caretakerId: string) => decide(tx, id, caretakerId, "dismissed");

/** A registered vet clears a cat for surgery: its confirmed hold reports end. The flags stay. Returns how many ended. */
export async function clearCatForSurgery(tx: Tx, catId: string, vetId: string): Promise<number> {
  const cleared = await tx
    .update(reports)
    .set({ status: "cleared", decidedBy: vetId, decidedAt: sql`now()` })
    .where(and(eq(reports.catId, catId), eq(reports.status, "confirmed"), inArray(reports.claim, [...HOLD_CLAIMS])))
    .returning({ id: reports.id, claim: reports.claim });
  for (const r of cleared) {
    await audit(tx, REPORT_CLEARED, "A vet cleared a cat for surgery.", { reportId: r.id, catId, claim: r.claim }, vetId);
  }
  if (cleared.length > 0) await enqueueWakeup(tx, REPORT_WAKEUP, { catId });
  return cleared.length;
}

/**
 * A caretaker has sorted a photo the AI could not match. Reports filed on it with no cat now belong to the cat, and
 * hold it. A report that would repeat one the person already made on that cat today stays unattached.
 */
export async function attachReports(tx: Tx, sightingId: string, catId: string): Promise<number> {
  const attached = await tx
    .update(reports)
    .set({ catId })
    .where(
      and(
        eq(reports.sightingId, sightingId),
        isNull(reports.catId),
        sql`not exists (
          select 1 from reports o
          where o.cat_id = ${catId} and o.claim = ${reports.claim} and o.reported_on = ${reports.reportedOn}
            and o.reporter_id is not distinct from ${reports.reporterId} and ${reports.reporterId} is not null
        )`,
      ),
    )
    .returning({ id: reports.id });
  if (attached.length > 0) await wakeOnce(tx, catId);
  return attached.length;
}

/** Cats a person must check before they can be funded: an open or confirmed hurt, pregnant or sick report. */
export async function heldCatIds(tx: Pick<Tx, "selectDistinct">): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ catId: reports.catId })
    .from(reports)
    .where(and(inArray(reports.claim, [...HOLD_CLAIMS]), inArray(reports.status, ["open", "confirmed"])));
  return new Set(rows.flatMap((r) => (r.catId ? [r.catId] : [])));
}
