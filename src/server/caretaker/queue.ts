import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AssessmentSchema, ReceiptSchema, type ReceiptReading } from "../ai/schemas";
import { db } from "../db/client";
import { agentActions, allowedPayees, bookings, cats, earTipFlags, guardrails, nameSuggestions, payouts, receipts, reviewRequests, sightings, users, wakeups } from "../db/schema";
import { COLONY } from "@/lib/config";
import { hidePrivateInDemo, maskEmail, placeForStaff } from "../demoPrivacy";
import { safeBio } from "../placeText";
import { needsHumanTick, regionsOf } from "../photoGate";
import { depositPaidOn, reasonMessages } from "../vetFlow";
import { manilaDate } from "../public";
import { deskTotal } from "@/lib/deskSections";

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
  /** Why it is here: a code from the spot flow. */
  reason: string | null;
  catId: string | null;
  catName: string | null;
  exact: ExactSpot;
  /** The place by name. Always set; it is all a demo screen shows. */
  area: string;
  /** True while the demo hides exact places. */
  exactHidden: boolean;
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
  depositPaid: number;
  packagePrice: number;
};

export type CaretakerQueue = {
  awaitingApproval: PayoutItem[];
  needsReview: PayoutItem[];
  longSent: PayoutItem[];
  sightings: SightingItem[];
  receipts: ReceiptItem[];
  /** Receipts that passed every check and wait for a caretaker to look at the vet's photo. */
  earTipConfirmations: ReceiptItem[];
  reviews: { id: string; subject: string; reason: string; date: string }[];
  failedWakeups: { id: string; kind: string; attempts: number; date: string }[];
  heldPhotos: { sightingId: string; catId: string | null; catName: string | null; state: string; hasRegions: boolean; needsTick: boolean; date: string }[];
  /** Spotted cats whose ears the flags have not settled yet, with how many people said each. */
  earTipPending: { id: string; name: string; yes: number; no: number; exact: ExactSpot; area: string; exactHidden: boolean }[];
  /** Cats marked neutered with no vet record, no money and no payout, so a caretaker can put a wrong call back. */
  neuteredWithoutRecord: { id: string; name: string }[];
  /** Ideas for a cat's real name, oldest first. Who sent each is not kept here. */
  nameSuggestions: { id: string; catId: string; catName: string; name: string; /** The newest sighting of the cat, for its photo. */ photoSightingId: string | null; date: string }[];
  /** For the merge menu. */
  catChoices: { id: string; name: string; status: string; sex: string; sexUnconfirmed: boolean; flags: string[] }[];
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
    .select({ id: cats.id, name: cats.name, status: cats.status, sex: cats.sex, sexUnconfirmed: cats.sexUnconfirmed, flags: cats.flags })
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
      ...placeForStaff(exactOf(s.exactLat, s.exactLng)),
      area: COLONY.area_name,
      assessment: parsed.success ? (hidePrivateInDemo() ? { ...parsed.data, short_bio: safeBio(parsed.data.short_bio, parsed.data.suggested_name) } : parsed.data) : null,
      candidates: ids.flatMap((id) => (nameOf.has(id) ? [{ id, name: nameOf.get(id)! }] : [])),
    };
  });

  const receiptItemsFor = async (verification: "needs_review" | "awaiting_ear_tip_confirmation"): Promise<ReceiptItem[]> => {
    const rows = await db
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
      .where(eq(receipts.verification, verification))
      .orderBy(asc(receipts.createdAt), asc(receipts.id));
    const items: ReceiptItem[] = [];
    for (const { r, booking, catName, vetName, clinicName } of rows) {
      const parsed = ReceiptSchema.safeParse(r.parsed);
      items.push({
        id: r.id,
        bookingId: booking.id,
        catName,
        vetName,
        clinicName,
        date: manilaDate(r.createdAt),
        reasons: r.reasons,
        reasonMessages: reasonMessages(r.reasons),
        parsed: parsed.success ? parsed.data : null,
        depositPaid: await depositPaidOn(db, booking.id),
        packagePrice: booking.packagePrice,
      });
    }
    return items;
  };
  const receiptItems = await receiptItemsFor("needs_review");
  const earTipConfirmations = await receiptItemsFor("awaiting_ear_tip_confirmation");

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
    .select({ id: cats.id, name: cats.name, area: cats.areaName, lat: cats.exactLat, lng: cats.exactLng, approx: cats.locationApproximate })
    .from(cats)
    .where(and(eq(cats.status, "spotted"), or(isNull(cats.earTipped))))
    .orderBy(asc(cats.createdAt));
  const flagCounts = await db
    .select({ catId: earTipFlags.catId, value: earTipFlags.value, n: sql<number>`count(*)::int` })
    .from(earTipFlags)
    .groupBy(earTipFlags.catId, earTipFlags.value);
  const countOf = (catId: string, value: string) => flagCounts.find((f) => f.catId === catId && f.value === value)?.n ?? 0;

  const noRecord = await db
    .select({ id: cats.id, name: cats.name })
    .from(cats)
    .where(
      and(
        eq(cats.status, "neutered"),
        sql`not exists (select 1 from treatments t where t.cat_id = ${cats.id} and t.type = 'neuter')`,
        sql`not exists (select 1 from allocations a where a.cat_id = ${cats.id})`,
        sql`not exists (select 1 from payouts p where p.cat_id = ${cats.id})`,
      ),
    )
    .orderBy(asc(cats.createdAt), asc(cats.id));

  const suggested = await db
    .select({
      id: nameSuggestions.id,
      catId: nameSuggestions.catId,
      catName: cats.name,
      name: nameSuggestions.name,
      createdAt: nameSuggestions.createdAt,
      photoSightingId: sql<string | null>`(select s.id from sightings s where s.cat_id = ${cats.id} and s.state in ('matched', 'new_cat') order by s.created_at desc, s.id desc limit 1)`,
    })
    .from(nameSuggestions)
    .innerJoin(cats, eq(cats.id, nameSuggestions.catId))
    .where(eq(nameSuggestions.status, "pending"))
    .orderBy(asc(nameSuggestions.createdAt), asc(nameSuggestions.id));

  return {
    awaitingApproval,
    needsReview,
    longSent,
    sightings: sightingItems,
    receipts: receiptItems,
    earTipConfirmations,
    reviews: reviews.map((r) => ({ id: r.id, subject: r.subject, reason: r.reason, date: manilaDate(r.createdAt) })),
    failedWakeups: failed.map((w) => ({ id: w.id, kind: w.kind, attempts: w.attempts, date: manilaDate(w.createdAt) })),
    heldPhotos: held.map(({ s, catName }) => ({
      sightingId: s.id,
      catId: s.catId,
      catName,
      state: s.state,
      hasRegions: regionsOf(s.assessment).length > 0,
      needsTick: needsHumanTick(s.assessment),
      date: manilaDate(s.createdAt),
    })),
    earTipPending: undecided.map((c) => ({ id: c.id, name: c.name, yes: countOf(c.id, "yes"), no: countOf(c.id, "no"), ...placeForStaff(exactOf(c.lat, c.lng, c.approx)), area: c.area })),
    neuteredWithoutRecord: noRecord,
    nameSuggestions: suggested.map((n) => ({ id: n.id, catId: n.catId, catName: n.catName, name: n.name, photoSightingId: n.photoSightingId, date: manilaDate(n.createdAt) })),
    catChoices: allCats,
  };
}

/** How many things wait for a caretaker: the same queue the desk lists, counted the way the desk counts. */
export async function caretakerWaiting(): Promise<number> {
  return deskTotal(await getCaretakerQueue());
}

export type RulesView = {
  limits: typeof guardrails.$inferSelect;
  vets: { id: string; username: string; clinicName: string | null; paypalEmail: string | null; emailHidden: boolean; allowed: boolean }[];
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
  return { limits, vets: vets.map((v) => ({ id: v.id, username: v.username, clinicName: v.clinicName, paypalEmail: hidePrivateInDemo() ? maskEmail(v.paypalEmail) : v.paypalEmail, emailHidden: hidePrivateInDemo(), allowed: v.allowedId !== null })) };
}
