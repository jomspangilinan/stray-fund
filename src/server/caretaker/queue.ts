import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AssessmentSchema, EarTipSchema, ReceiptSchema, type ReceiptReading } from "../ai/schemas";
import { db } from "../db/client";
import { agentActions, allowedPayees, bookings, cats, guardrails, payouts, receipts, reviewRequests, sightings, users, wakeups } from "../db/schema";
import { depositPaidOn, reasonMessages } from "../vetFlow";
import { manilaDate } from "../public";

export const LONG_SENT_MINUTES = 60;

export type ExactSpot = { lat: number; lng: number; approximate: boolean } | null;

export type PayoutItem = {
  id: string;
  kind: string;
  amount: number;
  status: string;
  catId: string;
  catName: string;
  vetName: string;
  date: string;
  /** The treasurer's own words. Model text: show as text only. */
  agentReason: string | null;
  batchId: string | null;
  attempts: number;
  /** For caretakers only. Never leaves this console. */
  lastGatewayError: string | null;
};

export type SightingItem = {
  id: string;
  date: string;
  /** Why it is here: a code from the catch flow. */
  reason: string | null;
  catId: string | null;
  catName: string | null;
  exact: ExactSpot;
  /** What the AI wrote. Untrusted text. */
  assessment: ReturnType<typeof AssessmentSchema.parse> | null;
  candidates: { id: string; name: string }[];
};

export type ReceiptItem = {
  id: string;
  bookingId: string;
  catName: string;
  vetName: string;
  clinicName: string | null;
  date: string;
  reasons: string[];
  /** Fixed sentences from our own codes. */
  reasonMessages: string[];
  /** What the AI read from the image. Untrusted text. */
  parsed: ReceiptReading | null;
  earTip: { ear_tip: string; confidence: number; same_cat_confidence: number } | null;
  depositPaid: number;
  packagePrice: number;
};

export type CaretakerQueue = {
  awaitingApproval: PayoutItem[];
  needsReview: PayoutItem[];
  longSent: PayoutItem[];
  sightings: SightingItem[];
  receipts: ReceiptItem[];
  reviews: { id: string; subject: string; reason: string; date: string }[];
  failedWakeups: { id: string; kind: string; attempts: number; date: string }[];
  heldPhotos: { sightingId: string; catId: string | null; catName: string | null; state: string; hasRegions: boolean; date: string }[];
  /** Spotted cats whose ears nobody has settled yet. */
  earTipPending: { id: string; name: string; exact: ExactSpot }[];
  /** For the merge menu. */
  catChoices: { id: string; name: string; status: string; sex: string; flags: string[] }[];
};

const exactOf = (lat: number | null, lng: number | null, approximate = false): ExactSpot =>
  lat !== null && lng !== null ? { lat, lng, approximate } : null;

async function payoutItems(statuses: string[], olderThanMinutes?: number): Promise<PayoutItem[]> {
  const rows = await db
    .select({
      id: payouts.id,
      kind: payouts.kind,
      amount: payouts.amount,
      status: payouts.status,
      catId: payouts.catId,
      catName: cats.name,
      vetName: users.username,
      createdAt: payouts.createdAt,
      agentReason: agentActions.reason,
      batchId: payouts.paypalPayoutBatchId,
      attempts: payouts.attempts,
      lastGatewayError: payouts.lastGatewayError,
    })
    .from(payouts)
    .innerJoin(cats, eq(cats.id, payouts.catId))
    .innerJoin(users, eq(users.id, payouts.payeeUserId))
    .leftJoin(agentActions, eq(agentActions.id, payouts.actionId))
    .where(
      and(
        inArray(payouts.status, statuses),
        olderThanMinutes === undefined
          ? undefined
          : sql`coalesce(${payouts.lastAttemptAt}, ${payouts.createdAt}) < now() - make_interval(mins => ${olderThanMinutes})`,
      ),
    )
    .orderBy(asc(payouts.createdAt), asc(payouts.id));
  return rows.map((r) => ({ ...r, date: manilaDate(r.createdAt) }));
}

/** Everything waiting for a person. Holds exact locations and private notes, so only a caretaker's page may call it. */
export async function getCaretakerQueue(): Promise<CaretakerQueue> {
  const [awaitingApproval, needsReview, longSent] = await Promise.all([
    payoutItems(["awaiting_approval"]),
    payoutItems(["needs_review"]),
    payoutItems(["sent"], LONG_SENT_MINUTES),
  ]);

  const allCats = await db
    .select({ id: cats.id, name: cats.name, status: cats.status, sex: cats.sex, flags: cats.flags })
    .from(cats)
    .orderBy(desc(cats.createdAt))
    .limit(200);
  const nameOf = new Map(allCats.map((c) => [c.id, c.name]));

  const waiting = await db
    .select({
      s: sightings,
      catName: cats.name,
    })
    .from(sightings)
    .leftJoin(cats, eq(cats.id, sightings.catId))
    .where(eq(sightings.state, "needs_review"))
    .orderBy(asc(sightings.createdAt), asc(sightings.id));
  const sightingItems: SightingItem[] = waiting.map(({ s, catName }) => {
    const parsed = AssessmentSchema.safeParse(s.assessment);
    const extra = (s.assessment ?? {}) as { review_reason?: unknown; candidate_cat_ids?: unknown };
    const ids = Array.isArray(extra.candidate_cat_ids) ? extra.candidate_cat_ids.filter((x): x is string => typeof x === "string") : [];
    if (s.catId && !ids.includes(s.catId)) ids.unshift(s.catId);
    return {
      id: s.id,
      date: manilaDate(s.createdAt),
      reason: typeof extra.review_reason === "string" ? extra.review_reason : null,
      catId: s.catId,
      catName,
      exact: exactOf(s.exactLat, s.exactLng),
      assessment: parsed.success ? parsed.data : null,
      candidates: ids.flatMap((id) => (nameOf.has(id) ? [{ id, name: nameOf.get(id)! }] : [])),
    };
  });

  const waitingReceipts = await db
    .select({
      r: receipts,
      booking: bookings,
      catName: cats.name,
      vetName: users.username,
      clinicName: users.clinicName,
    })
    .from(receipts)
    .innerJoin(bookings, eq(bookings.id, receipts.bookingId))
    .innerJoin(cats, eq(cats.id, bookings.catId))
    .innerJoin(users, eq(users.id, bookings.vetId))
    .where(eq(receipts.verification, "needs_review"))
    .orderBy(asc(receipts.createdAt), asc(receipts.id));
  const receiptItems: ReceiptItem[] = [];
  for (const { r, booking, catName, vetName, clinicName } of waitingReceipts) {
    const parsed = ReceiptSchema.safeParse(r.parsed);
    const ear = EarTipSchema.safeParse(r.earTipResult);
    receiptItems.push({
      id: r.id,
      bookingId: booking.id,
      catName,
      vetName,
      clinicName,
      date: manilaDate(r.createdAt),
      reasons: r.reasons,
      reasonMessages: reasonMessages(r.reasons),
      parsed: parsed.success ? parsed.data : null,
      earTip: ear.success ? ear.data : null,
      depositPaid: await depositPaidOn(db, booking.id),
      packagePrice: booking.packagePrice,
    });
  }

  const reviews = await db
    .select()
    .from(reviewRequests)
    .where(eq(reviewRequests.status, "open"))
    .orderBy(asc(reviewRequests.createdAt), asc(reviewRequests.id));
  const failed = await db.select().from(wakeups).where(eq(wakeups.status, "failed")).orderBy(desc(wakeups.createdAt)).limit(50);

  const held = await db
    .select({ s: sightings, catName: cats.name })
    .from(sightings)
    .leftJoin(cats, eq(cats.id, sightings.catId))
    .where(and(eq(sightings.publicReady, false), inArray(sightings.state, ["matched", "new_cat", "needs_review"])))
    .orderBy(desc(sightings.createdAt))
    .limit(50);

  const undecided = await db
    .select({ id: cats.id, name: cats.name, lat: cats.exactLat, lng: cats.exactLng, approx: cats.locationApproximate })
    .from(cats)
    .where(and(eq(cats.status, "spotted"), or(isNull(cats.earTipped))))
    .orderBy(asc(cats.createdAt));

  return {
    awaitingApproval,
    needsReview,
    longSent,
    sightings: sightingItems,
    receipts: receiptItems,
    reviews: reviews.map((r) => ({ id: r.id, subject: r.subject, reason: r.reason, date: manilaDate(r.createdAt) })),
    failedWakeups: failed.map((w) => ({ id: w.id, kind: w.kind, attempts: w.attempts, date: manilaDate(w.createdAt) })),
    heldPhotos: held.map(({ s, catName }) => ({
      sightingId: s.id,
      catId: s.catId,
      catName,
      state: s.state,
      hasRegions: Array.isArray((s.assessment as { sensitive_regions?: unknown } | null)?.sensitive_regions) &&
        ((s.assessment as { sensitive_regions: unknown[] }).sensitive_regions.length > 0),
      date: manilaDate(s.createdAt),
    })),
    earTipPending: undecided.map((c) => ({ id: c.id, name: c.name, exact: exactOf(c.lat, c.lng, c.approx) })),
    catChoices: allCats,
  };
}

export type RulesView = {
  limits: typeof guardrails.$inferSelect;
  vets: { id: string; username: string; clinicName: string | null; paypalEmail: string | null; allowed: boolean }[];
};

/** The spending rules and the vets, with their private details. Caretakers only. */
export async function getRulesView(): Promise<RulesView> {
  const [limits] = await db.select().from(guardrails).where(eq(guardrails.id, 1));
  const vets = await db
    .select({
      id: users.id,
      username: users.username,
      clinicName: users.clinicName,
      paypalEmail: users.paypalEmail,
      allowedId: allowedPayees.userId,
    })
    .from(users)
    .leftJoin(allowedPayees, and(eq(allowedPayees.userId, users.id), eq(allowedPayees.kind, "vet")))
    .where(eq(users.role, "vet"))
    .orderBy(asc(users.username));
  return { limits, vets: vets.map((v) => ({ id: v.id, username: v.username, clinicName: v.clinicName, paypalEmail: v.paypalEmail, allowed: v.allowedId !== null })) };
}
