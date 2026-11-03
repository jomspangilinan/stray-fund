import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import * as z from "zod/v4";
import { CURRENCY } from "@/lib/config";
import { fileReview } from "./agent/review";
import { readReceipt, verifyEarTip } from "./ai/receipt";
import { EarTipSchema, ReceiptSchema, type EarTipCheck, type ReceiptReading } from "./ai/schemas";
import { RateLimited } from "./catch";
import { COMPLETED_BOOKING, transitionCat } from "./catTransitions";
import { db, withColonyLock, type Tx } from "./db/client";
import { allowedPayees, bookings, cats, guardrails, payouts, receipts, sightings, treatments, users } from "./db/schema";
import { CONFIRMED_BOOKING } from "./guardrails";
import { CAPTURED, returnSurplus, toInt, unspentForCat } from "./ledger";
import { storeOriginal } from "./photos";
import { isPlainText } from "./plainText";
import { manilaDate } from "./public";
import { StoredObjectMissing, getStorage } from "./storage";
import { enqueueWakeup } from "./wakeups";

export type Booking = typeof bookings.$inferSelect;
export type Verification = "pending" | "verified" | "rejected" | "needs_review";
export type EvidenceResult = { verification: Verification; reasons: string[] };

/** A receipt's total may differ from the package by this much, in centavos, and still count as the package. */
export const PRICE_TOLERANCE = 100;
export const EVIDENCE_PER_MINUTE = 5;
export const BOOKINGS_PER_MINUTE = 10;
export const RETRY_AFTER_SECONDS = 60;
export const RETRY_BATCH = 10;
const MAX_REFERENCES = 3;
const MAX_PRODUCT = 60;
const MANILA_OFFSET = "+08:00";

export class VetFlowError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "VetFlowError";
  }
}

/*
 * Reasons are fixed codes. A reading comes from an untrusted image through a model,
 * so none of its text is ever copied into a reason, a review or an event.
 */
const REASON_MESSAGES = {
  receipt_unreadable: "We could not read the receipt. Take a new, clear photo of the whole receipt.",
  clinic_mismatch: "The clinic on the receipt does not match the clinic on your account.",
  date_unreadable: "We could not read the date on the receipt.",
  date_before_booking: "The receipt is dated before the booking.",
  date_in_future: "The receipt is dated in the future.",
  total_unreadable: "We could not read the total on the receipt.",
  total_above_package: "The total is above the care package price, so a caretaker has to look at it.",
  total_not_above_deposit: "The total does not come to more than the deposit already paid, so a caretaker has to look at it.",
  currency_mismatch: "The receipt is not in pesos, or we could not read the currency.",
  cat_name_mismatch: "The cat's name on the receipt does not match this booking.",
  tamper_signs: "The receipt shows signs of editing, or contains text that does not belong on a receipt.",
  receipt_number_unreadable: "We could not read the receipt number.",
  ear_tip_unreadable: "We could not check the photo. Take a new one of the cat's ears.",
  ear_tip_not_confirmed: "The photo does not confirm a tipped ear. Take a new one showing the ears clearly.",
  ear_tip_low_confidence: "The ear tip is not clear enough in the photo. Take a new one, closer and in good light.",
  not_same_cat: "The photo may not show the same cat as this booking.",
  no_reference_photos: "We have no earlier photos of this cat to compare with, so a caretaker has to look at it.",
  booking_not_open: "This booking is no longer open.",
  cat_not_in_care: "This cat is not in care.",
  deposit_not_paid: "The deposit for this booking has not been paid.",
  evidence_file_missing: "We could not find the photos you sent. Please send them again.",
  surplus_unavailable: "The money held for this cat does not match the receipt, so a caretaker has to look at it.",
  duplicate_receipt_image: "This receipt image has already been used. Take a new photo of the correct receipt.",
  duplicate_receipt_number: "This receipt number has already been used.",
  superseded: "A newer submission replaced this one.",
  caretaker_rejected: "A caretaker looked at this and did not accept it. Send a new receipt and a clear photo of the ears.",
} as const;

export type ReasonCode = keyof typeof REASON_MESSAGES;

/** Stored reasons are this module's own codes, but a row is still read defensively. */
export const reasonMessages = (reasons: string[]): string[] =>
  reasons.flatMap((r) => (Object.hasOwn(REASON_MESSAGES, r) ? [REASON_MESSAGES[r as ReasonCode]] : []));

// ---------- Dates ----------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** YYYY-MM-DD for a real calendar date, or null. */
function isoDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

const fullYear = (raw: string) => (raw.length === 2 ? 2000 + Number(raw) : Number(raw));
const monthOf = (name: string): number | undefined => MONTHS[name.toLowerCase().slice(0, 3)];

/**
 * The date a printed string means, or null. A numeric date is month first, as clinics here
 * print it, and day first only when the first field cannot be a month. So a stale day-first
 * receipt can pass this one check, an accepted trade-off since number, clinic, total and
 * ear-tip still apply. Never uses Date parsing, which depends on the machine's zone and locale.
 */
export function receiptDate(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(text);
  if (m) {
    const [first, second] = [Number(m[1]), Number(m[2])];
    return first <= 12 ? isoDate(fullYear(m[3]), first, second) : isoDate(fullYear(m[3]), second, first);
  }

  m = /\b([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4}|\d{2})\b/.exec(text);
  if (m && monthOf(m[1])) return isoDate(fullYear(m[3]), monthOf(m[1])!, Number(m[2]));
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4}|\d{2})\b/.exec(text);
  if (m && monthOf(m[2])) return isoDate(fullYear(m[3]), monthOf(m[2])!, Number(m[1]));
  return null;
}

/** Adds whole years and months to a calendar date. A day that does not exist becomes the month's last. */
export function addCalendar(date: string, add: { years?: number; months?: number }): string {
  const [y, m, d] = date.split("-").map(Number);
  const months = (y * 12 + (m - 1)) + (add.years ?? 0) * 12 + (add.months ?? 0);
  const year = Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

// ---------- Comparing what a receipt says ----------

const GENERIC_WORDS = new Set([
  "vet", "vets", "veterinary", "veterinarian", "clinic", "animal", "animals", "pet", "pets",
  "hospital", "center", "centre", "care", "the", "and", "of", "inc", "dr", "brgy",
]);

const words = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * Containment either way, on whole words, or equal once spaces are ignored. The shorter
 * side has to say something specific, since "Vet Clinic" or an empty string would otherwise
 * match every clinic there is.
 */
function clinicMatches(printed: string | null, registered: string | null): boolean {
  if (!printed || !registered) return false;
  const [a, b] = [words(printed), words(registered)];
  if (a.length === 0 || b.length === 0) return false;
  if (a.join("") === b.join("")) return a.some((w) => !GENERIC_WORDS.has(w));
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.some((w) => !GENERIC_WORDS.has(w))) return false;
  return ` ${long.join(" ")} `.includes(` ${short.join(" ")} `);
}

export const normalizeReceiptNumber = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const n = raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return n === "" ? null : n;
};

function currencyMatches(printed: string | null): boolean {
  const c = printed?.trim().toUpperCase();
  return c === CURRENCY || ((c === "₱" || c === "P") && CURRENCY === "PHP");
}

// ---------- The decision ----------

export type VerificationDecision = { verification: "verified" | "rejected" | "needs_review"; reasons: ReasonCode[] };

export type DecisionBooking = Pick<Booking, "status" | "packagePrice" | "scheduledFor"> & {
  /** Centavos of deposit that have succeeded on this booking. */
  depositPaid: number;
};
export type DecisionCat = { name: string; status: string; referencePhotos: number };
export type DecisionVet = { clinicName: string | null };
export type DecisionLimits = { earTipConfidenceMin: number; matchConfidenceMin: number };
export type DecisionDup = { hash: boolean; receiptNumber: boolean };

/**
 * Code decides, never the model: a reading is only a claim about an image. Pure, with the
 * clock passed in. Only a verified decision writes treatments or moves the cat. Any other
 * outcome writes nothing but the reasons.
 */
export function decideVerification(
  parsed: ReceiptReading | null,
  earTip: EarTipCheck | null,
  booking: DecisionBooking,
  cat: DecisionCat,
  vet: DecisionVet,
  limits: DecisionLimits,
  dup: DecisionDup,
  now: Date,
): VerificationDecision {
  const duplicates: ReasonCode[] = [];
  if (dup.hash) duplicates.push("duplicate_receipt_image");
  if (dup.receiptNumber) duplicates.push("duplicate_receipt_number");
  if (duplicates.length > 0) return { verification: "rejected", reasons: duplicates };

  const reasons: ReasonCode[] = [];
  if (booking.status !== CONFIRMED_BOOKING) reasons.push("booking_not_open");
  if (cat.status !== "in_care") reasons.push("cat_not_in_care");
  if (booking.depositPaid <= 0) reasons.push("deposit_not_paid");

  if (!parsed) {
    reasons.push("receipt_unreadable");
  } else {
    if (!clinicMatches(parsed.clinic, vet.clinicName)) reasons.push("clinic_mismatch");

    const printed = receiptDate(parsed.date);
    if (printed === null) {
      reasons.push("date_unreadable");
    } else {
      const booked = booking.scheduledFor ? manilaDate(booking.scheduledFor) : null;
      if (booked === null || printed < booked) reasons.push("date_before_booking");
      if (printed > manilaDate(now)) reasons.push("date_in_future");
    }

    const total = parsed.total_centavos;
    if (total === null) {
      reasons.push("total_unreadable");
    } else {
      if (total > booking.packagePrice + PRICE_TOLERANCE) reasons.push("total_above_package");
      if (total <= 0 || total <= booking.depositPaid) reasons.push("total_not_above_deposit");
    }

    if (!currencyMatches(parsed.currency)) reasons.push("currency_mismatch");

    const printedName = words(parsed.cat_name ?? "").join(" ");
    if (printedName !== "" && printedName !== words(cat.name).join(" ")) reasons.push("cat_name_mismatch");

    if (parsed.tamper_signs.length > 0) reasons.push("tamper_signs");
    if (normalizeReceiptNumber(parsed.receipt_number) === null) reasons.push("receipt_number_unreadable");
  }

  if (!earTip) {
    reasons.push("ear_tip_unreadable");
  } else {
    if (earTip.ear_tip !== "present") reasons.push("ear_tip_not_confirmed");
    else if (earTip.confidence < limits.earTipConfidenceMin) reasons.push("ear_tip_low_confidence");
    if (cat.referencePhotos <= 0) reasons.push("no_reference_photos");
    else if (earTip.same_cat_confidence < limits.matchConfidenceMin) reasons.push("not_same_cat");
  }

  return reasons.length > 0 ? { verification: "needs_review", reasons } : { verification: "verified", reasons: [] };
}

// ---------- Shared loads ----------

async function loadLimits(tx: Tx) {
  const [limits] = await tx.select().from(guardrails).where(eq(guardrails.id, 1));
  if (!limits) throw new Error("Guardrails row is missing");
  return limits;
}

export async function depositPaidOn(tx: Tx | typeof db, bookingId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${payouts.amount}), 0)::bigint` })
    .from(payouts)
    .where(and(eq(payouts.bookingId, bookingId), eq(payouts.kind, "deposit"), eq(payouts.status, "succeeded")));
  return toInt(row.total);
}

// ---------- Booking ----------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A scheduled day in Manila, stored as the start of that day. */
function parseBookingDate(date: string): string {
  const m = DATE_ONLY.exec(date);
  const iso = m && isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!iso) throw new VetFlowError("BAD_DATE", 400, "Choose a valid date.");
  return iso;
}

async function assertBookingRate(tx: Tx | typeof db, vetId: string): Promise<void> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.vetId, vetId), sql`${bookings.createdAt} > now() - interval '1 minute'`));
  if (row.n >= BOOKINGS_PER_MINUTE) throw new RateLimited();
}

/** Checked before any work is done, so a flood is cheap to refuse. */
export const assertUnderBookingLimit = (vetId: string) => assertBookingRate(db, vetId);

/** The colony lock serialises this with funding and other bookings, so the cat's state cannot move underneath it. */
export async function confirmBooking(vetId: string, catId: string, date: string): Promise<Booking> {
  const day = parseBookingDate(date);
  if (day < manilaDate(new Date())) throw new VetFlowError("DATE_IN_PAST", 400, "Choose today or a later date.");

  return withColonyLock(async (tx) => {
    await assertBookingRate(tx, vetId);
    const [vet] = await tx.select().from(users).where(eq(users.id, vetId));
    const [allowed] = await tx
      .select({ userId: allowedPayees.userId })
      .from(allowedPayees)
      .where(and(eq(allowedPayees.userId, vetId), eq(allowedPayees.kind, "vet")));
    if (!vet || vet.role !== "vet" || !allowed || !vet.paypalEmail) {
      throw new VetFlowError("PAYEE_NOT_ALLOWED", 403, "This account cannot take bookings yet. Ask a caretaker to set it up.");
    }

    const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
    if (!cat) throw new VetFlowError("CAT_NOT_FOUND", 404, "There is no such cat.");
    if (cat.status !== "funded") throw new VetFlowError("CAT_NOT_FUNDED", 409, "This cat is not waiting for a booking.");

    const { packagePrice } = await loadLimits(tx);
    // The gate would refuse the balance later, once a vet has already done the work.
    const [held] = (
      await tx.execute(sql`
        select coalesce(sum(a.amount), 0)::bigint as total
        from allocations a join donations d on d.id = a.donation_id
        where a.cat_id = ${catId} and d.status = ${CAPTURED}
      `)
    ).rows as { total: unknown }[];
    if (toInt(held.total) < packagePrice) {
      throw new VetFlowError("UNDERFUNDED", 409, "The money set aside for this cat no longer covers the care package. Ask a caretaker.");
    }

    const [booking] = await tx
      .insert(bookings)
      .values({
        catId,
        vetId,
        packagePrice,
        status: CONFIRMED_BOOKING,
        scheduledFor: new Date(`${day}T00:00:00${MANILA_OFFSET}`),
      })
      .returning();
    await transitionCat(tx, catId, "booked");
    await enqueueWakeup(tx, "booking_confirmed", { bookingId: booking.id, catId });
    return booking;
  });
}

// ---------- Evidence ----------

type BookingState = { catStatus: string; depositPaid: number; booking: Booking; latest: Verification | null };

/** Why this booking cannot take evidence right now, if so. Owner, state and deposit, in that order. */
function refusal(vetId: string, s: BookingState): VetFlowError | null {
  if (s.booking.vetId !== vetId) return new VetFlowError("NOT_YOUR_BOOKING", 403, "This booking belongs to another vet.");
  if (s.latest === "verified") return new VetFlowError("ALREADY_VERIFIED", 409, "This booking's receipt is already verified.");
  if (s.booking.status !== CONFIRMED_BOOKING) return new VetFlowError("BOOKING_NOT_OPEN", 409, "This booking is closed.");
  if (s.depositPaid <= 0) return new VetFlowError("DEPOSIT_NOT_PAID", 409, "Evidence opens once the deposit has reached you.");
  if (s.catStatus !== "in_care") return new VetFlowError("CAT_NOT_IN_CARE", 409, "Evidence opens once the cat is in care.");
  if (s.latest === "pending") return new VetFlowError("EVIDENCE_PENDING", 409, "Your last submission is still being checked.");
  return null;
}

async function loadBookingState(tx: Tx | typeof db, bookingId: string): Promise<BookingState | null> {
  const [row] = await tx
    .select({ booking: bookings, catStatus: cats.status })
    .from(bookings)
    .innerJoin(cats, eq(cats.id, bookings.catId))
    .where(eq(bookings.id, bookingId));
  if (!row) return null;
  // A verified or pending row outranks any older attempts. The index allows only one of them.
  const [live] = await tx
    .select({ verification: receipts.verification })
    .from(receipts)
    .where(and(eq(receipts.bookingId, bookingId), inArray(receipts.verification, ["pending", "verified"])));
  return {
    booking: row.booking,
    catStatus: row.catStatus,
    depositPaid: await depositPaidOn(tx, bookingId),
    latest: (live?.verification as Verification | undefined) ?? null,
  };
}

async function assertEvidenceRate(tx: Tx | typeof db, vetId: string): Promise<void> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(receipts)
    .innerJoin(bookings, eq(bookings.id, receipts.bookingId))
    .where(and(eq(bookings.vetId, vetId), sql`${receipts.createdAt} > now() - interval '1 minute'`));
  if (row.n >= EVIDENCE_PER_MINUTE) throw new RateLimited();
}

/** Checked by the route before it reads the body, and again under the lock. */
export async function assertCanSubmitEvidence(vetId: string, bookingId: string): Promise<void> {
  const state = await loadBookingState(db, bookingId);
  if (!state) throw new VetFlowError("BOOKING_NOT_FOUND", 404, "There is no such booking.");
  const refused = refusal(vetId, state);
  if (refused) throw refused;
  await assertEvidenceRate(db, vetId);
}

const hashUsed = async (tx: Tx | typeof db, hash: string) =>
  (await tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.sha256, hash)).limit(1)).length > 0;

const DUPLICATE_RESULT: EvidenceResult = { verification: "rejected", reasons: ["duplicate_receipt_image"] };

async function fileEvidenceReview(tx: Tx, bookingId: string, verification: "rejected" | "needs_review"): Promise<void> {
  if (verification === "rejected") {
    await fileReview(
      tx,
      `Reused receipt on booking ${bookingId}`,
      "A vet sent a receipt that was already used, so it was refused and nothing was paid. Please check it.",
    );
    return;
  }
  await fileReview(
    tx,
    `Evidence on booking ${bookingId} needs a person`,
    "A vet's receipt or ear-tip photo could not be confirmed by the checks, so the balance stays unpaid. Please look at it.",
  );
}

/**
 * Stores both images and commits a pending row before any AI runs, so nothing is lost
 * if the AI fails, and no transaction is open while it runs. The hash covers the raw
 * bytes and is checked first: a used hash costs no AI call and no budget.
 */
export async function submitEvidence(i: {
  vetId: string;
  bookingId: string;
  receipt: Buffer;
  earTipPhoto: Buffer;
}): Promise<EvidenceResult> {
  await assertCanSubmitEvidence(i.vetId, i.bookingId);

  const sha256 = createHash("sha256").update(i.receipt).digest("hex");
  if (await hashUsed(db, sha256)) {
    await db.transaction((tx) => fileEvidenceReview(tx, i.bookingId, "rejected"));
    return DUPLICATE_RESULT;
  }

  const [{ key: fileKey }, { key: earTipPhotoKey }] = await Promise.all([
    storeOriginal(i.receipt),
    storeOriginal(i.earTipPhoto),
  ]);

  const receiptId = await withColonyLock(async (tx) => {
    // Everything may have moved while the images were being stored.
    const state = await loadBookingState(tx, i.bookingId);
    if (!state) throw new VetFlowError("BOOKING_NOT_FOUND", 404, "There is no such booking.");
    const refused = refusal(i.vetId, state);
    if (refused) throw refused;
    await assertEvidenceRate(tx, i.vetId);
    if (await hashUsed(tx, sha256)) {
      await fileEvidenceReview(tx, i.bookingId, "rejected");
      return null;
    }
    // Replaced attempts stay as rows, so their images count as used for good.
    await tx
      .update(receipts)
      .set({ verification: "rejected", reasons: ["superseded"] })
      .where(and(eq(receipts.bookingId, i.bookingId), eq(receipts.verification, "needs_review")));
    const [row] = await tx
      .insert(receipts)
      .values({ bookingId: i.bookingId, fileKey, sha256, earTipPhotoKey, verification: "pending" })
      .returning({ id: receipts.id });
    return row.id;
  });
  if (receiptId === null) return DUPLICATE_RESULT;

  try {
    return await finishEvidence(receiptId);
  } catch (e) {
    // The evidence is safe in a pending row, and the worker will finish it.
    console.error(`[vet] evidence check failed: ${e instanceof Error ? e.name : typeof e}`);
    return { verification: "pending", reasons: [] };
  }
}

type Stop = "budget" | "unavailable";
type Run = { result: EvidenceResult; stop?: Stop };

/** What the ear-tip column holds: the model's report, and how many reference photos it actually saw. */
const StoredEarTip = EarTipSchema.extend({ reference_count: z.number().int().min(0) });

/**
 * Sightings confirmed as this cat, from before the booking. A later one could be the post-op
 * photo itself passed off as a reference, and an unconfirmed one may be another cat.
 */
async function referencePhotos(catId: string, bookingId: string): Promise<Buffer[]> {
  const shots = await db
    .select({ key: sightings.originalKey })
    .from(sightings)
    .where(
      and(
        eq(sightings.catId, catId),
        inArray(sightings.state, ["matched", "new_cat"]),
        sql`${sightings.createdAt} < (select created_at from ${bookings} where ${bookings.id} = ${bookingId})`,
      ),
    )
    .orderBy(desc(sightings.createdAt))
    .limit(MAX_REFERENCES);
  const storage = getStorage();
  const photos: Buffer[] = [];
  for (const { key } of shots) {
    try {
      photos.push(await storage.getPrivate(key));
    } catch {
      // A missing reference only makes the comparison weaker, and none at all means a person decides.
    }
  }
  return photos;
}

const isStop = (reason: string): reason is Stop => reason === "budget" || reason === "unavailable";

/** Runs the AI for a pending receipt with no transaction open, then applies the outcome. */
async function runEvidence(receiptId: string): Promise<Run> {
  const [r] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (!r) throw new Error(`Receipt not found: ${receiptId}`);
  if (r.verification !== "pending") {
    return { result: { verification: r.verification as Verification, reasons: r.reasons } };
  }
  try {
    return await checkPending(r);
  } catch (e) {
    if (e instanceof StoredObjectMissing) return { result: await markEvidenceLost(r.id, r.bookingId) };
    throw e;
  }
}

/** A stored image is gone for good, and retrying cannot bring it back, so the vet is asked again. */
async function markEvidenceLost(receiptId: string, bookingId: string): Promise<EvidenceResult> {
  return withColonyLock(async (tx) => {
    const [row] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
    if (row.verification !== "pending") return { verification: row.verification as Verification, reasons: row.reasons };
    const reasons: ReasonCode[] = ["evidence_file_missing"];
    await tx.update(receipts).set({ verification: "needs_review", reasons }).where(eq(receipts.id, receiptId));
    await fileEvidenceReview(tx, bookingId, "needs_review");
    return { verification: "needs_review", reasons };
  });
}

async function checkPending(r: typeof receipts.$inferSelect): Promise<Run> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, r.bookingId));
  const pending: EvidenceResult = { verification: "pending", reasons: [] };
  const storage = getStorage();

  // A stored result on a pending row means an earlier run got this far. Do not pay for it twice.
  let parsed: ReceiptReading | null;
  const storedReading = ReceiptSchema.safeParse(r.parsed);
  if (storedReading.success) {
    parsed = storedReading.data;
  } else {
    const read = await readReceipt(await storage.getPrivate(r.fileKey));
    if (!read.ok && isStop(read.reason)) return { result: pending, stop: read.reason };
    parsed = read.ok ? read.data : null;
    if (parsed) {
      await db
        .update(receipts)
        .set({ parsed })
        .where(and(eq(receipts.id, r.id), eq(receipts.verification, "pending")));
    }
  }

  let earTip: EarTipCheck | null;
  let referenceCount: number;
  const storedEar = StoredEarTip.safeParse(r.earTipResult);
  if (storedEar.success) {
    earTip = storedEar.data;
    referenceCount = storedEar.data.reference_count;
  } else {
    const references = await referencePhotos(booking.catId, booking.id);
    referenceCount = references.length;
    if (!r.earTipPhotoKey) throw new StoredObjectMissing();
    const check = await verifyEarTip(await storage.getPrivate(r.earTipPhotoKey), references);
    if (!check.ok && isStop(check.reason)) return { result: pending, stop: check.reason };
    earTip = check.ok ? check.data : null;
    if (earTip) {
      await db
        .update(receipts)
        .set({ earTipResult: { ...earTip, reference_count: referenceCount } })
        .where(and(eq(receipts.id, r.id), eq(receipts.verification, "pending")));
    }
  }

  return { result: await applyEvidence(r.id, parsed, earTip, referenceCount) };
}

/** Finishes a pending receipt, or returns the outcome it already has. */
export async function finishEvidence(receiptId: string): Promise<EvidenceResult> {
  return (await runEvidence(receiptId)).result;
}

async function receiptNumberUsed(tx: Tx, number: string | null, receiptId: string): Promise<boolean> {
  if (number === null) return false;
  const rows = await tx
    .select({ number: sql<unknown>`${receipts.parsed}->>'receipt_number'` })
    .from(receipts)
    .where(and(ne(receipts.id, receiptId), inArray(receipts.verification, ["verified", "pending"]), isNotNull(receipts.parsed)));
  return rows.some((row) => normalizeReceiptNumber(row.number) === number);
}

/**
 * Applies the outcome in one transaction, under the colony lock because it moves money
 * back to the pool. Conditional on the row being pending, so a second call changes nothing.
 * Everything the decision rests on is read here, not before the AI ran.
 */
async function applyEvidence(
  receiptId: string,
  parsed: ReceiptReading | null,
  earTip: EarTipCheck | null,
  referenceCount: number,
): Promise<EvidenceResult> {
  return withColonyLock(async (tx) => {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
    if (!r) throw new Error(`Receipt not found: ${receiptId}`);
    if (r.verification !== "pending") {
      return { verification: r.verification as Verification, reasons: r.reasons };
    }

    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, r.bookingId));
    const [cat] = await tx.select().from(cats).where(eq(cats.id, booking.catId)).for("update");
    const [vet] = await tx.select().from(users).where(eq(users.id, booking.vetId));
    const limits = await loadLimits(tx);
    const depositPaid = await depositPaidOn(tx, booking.id);
    const number = normalizeReceiptNumber(parsed?.receipt_number);

    let decision: VerificationDecision = decideVerification(
      parsed,
      earTip,
      { status: booking.status, packagePrice: booking.packagePrice, scheduledFor: booking.scheduledFor, depositPaid },
      { name: cat.name, status: cat.status, referencePhotos: referenceCount },
      { clinicName: vet.clinicName },
      { earTipConfidenceMin: limits.earTipConfidenceMin, matchConfidenceMin: limits.matchConfidenceMin },
      // The unique index holds the hash, and the row got past that check when it was inserted.
      { hash: false, receiptNumber: await receiptNumberUsed(tx, number, r.id) },
      new Date(),
    );

    const total = parsed?.total_centavos ?? 0;
    const surplus = surplusToReturn(booking.packagePrice, total);
    // Throwing here would leave the row pending and retried for ever, so a person looks instead.
    if (decision.verification === "verified" && (await surplusUnavailable(tx, cat.id, surplus))) {
      decision = { verification: "needs_review", reasons: ["surplus_unavailable"] };
    }

    await tx
      .update(receipts)
      .set({
        verification: decision.verification,
        reasons: decision.reasons,
        ...(parsed ? { parsed } : {}),
        ...(earTip ? { earTipResult: { ...earTip, reference_count: referenceCount } } : {}),
      })
      .where(eq(receipts.id, r.id));

    if (decision.verification !== "verified") {
      await fileEvidenceReview(tx, booking.id, decision.verification);
      return { verification: decision.verification, reasons: decision.reasons };
    }

    // parsed and its date are non-null here, since the decision verified them.
    await applyVerifiedOutcome(tx, {
      receiptId: r.id,
      booking,
      catId: cat.id,
      parsed: parsed!,
      treatedOn: receiptDate(parsed!.date)!,
      surplus,
    });
    return { verification: "verified", reasons: [] };
  });
}

/** What goes back to the pool when a receipt comes in under the package price. Within the tolerance, nothing. */
export function surplusToReturn(packagePrice: number, total: number): number {
  const surplus = packagePrice - total;
  return surplus > PRICE_TOLERANCE ? surplus : 0;
}

/** Caller must hold the colony lock. True when the cat no longer holds enough unspent money to return. */
export async function surplusUnavailable(tx: Tx, catId: string, surplus: number): Promise<boolean> {
  return surplus > 0 && surplus > (await unspentForCat(tx, catId));
}

/**
 * The one place a verified receipt takes effect, for the code path and for a caretaker's
 * override alike: the three treatments, the cat neutered and ear-tipped, any surplus back to
 * the pool, and the wakeup. The caller holds the colony lock, has marked the receipt verified,
 * and has checked surplusUnavailable.
 */
export async function applyVerifiedOutcome(
  tx: Tx,
  o: { receiptId: string; booking: Booking; catId: string; parsed: ReceiptReading; treatedOn: string; surplus: number },
): Promise<void> {
  await tx
    .insert(treatments)
    .values(treatmentRows(o.parsed, o.treatedOn, { catId: o.catId, vetId: o.booking.vetId, receiptId: o.receiptId }))
    .onConflictDoNothing();
  await transitionCat(tx, o.catId, "neutered");
  await tx.update(cats).set({ earTipped: true }).where(eq(cats.id, o.catId));
  if (o.surplus > 0) await returnSurplus(tx, o.catId, o.surplus);
  await enqueueWakeup(tx, "evidence_ready", { bookingId: o.booking.id, catId: o.catId });
}

const PRODUCT_WORDS = {
  neuter: /\b(neuter|spay|kapon|castrat|ovariohyster)/i,
  vaccine: /\b(rabies|anti-?rabies|rabisin|nobivac|defensor)/i,
  deworming: /\b(de-?worm|praziquantel|pyrantel|drontal|milbemax|fenbendazole)/i,
};
const GENERIC_PRODUCT = { neuter: "Spay or neuter surgery", vaccine: "Anti-rabies vaccine", deworming: "Deworming" };
const PRODUCT_CHARS = /^[\p{L}\p{N} .,'()/%-]+$/u;
const INSTRUCTION_WORDS = /\b(approve|approved|pay|paid|payment|transfer|send|ignore|instruction|instructions|system|prompt|admin|release|verified|assistant)\b/i;

/** Clinics print the price on the same line. A public health record has no use for it. */
const TRAILING_PRICE = /[\s.:-]*(?:(?:PHP|Php|₱|P)\s*[\d,]+(?:\.\d{1,2})?|[\d,]*\d\.\d{2})\s*$/;

/** Treatments are public, and an item is text from an image. Anything but a short plain label gives way to generic words. */
function productFor(type: keyof typeof PRODUCT_WORDS, items: string[]): string {
  const item = items.map((s) => s.replace(TRAILING_PRICE, "").trim()).find((s) => PRODUCT_WORDS[type].test(s));
  const safe =
    item !== undefined &&
    item.length <= MAX_PRODUCT &&
    PRODUCT_CHARS.test(item) &&
    isPlainText(item) &&
    !INSTRUCTION_WORDS.test(item);
  return safe ? item : GENERIC_PRODUCT[type];
}

function treatmentRows(
  parsed: ReceiptReading,
  date: string,
  ids: { catId: string; vetId: string; receiptId: string },
): (typeof treatments.$inferInsert)[] {
  return [
    { ...ids, date, type: "neuter", product: productFor("neuter", parsed.items), nextDue: null },
    { ...ids, date, type: "vaccine", product: productFor("vaccine", parsed.items), nextDue: addCalendar(date, { years: 1 }) },
    { ...ids, date, type: "deworming", product: productFor("deworming", parsed.items), nextDue: addCalendar(date, { months: 3 }) },
  ];
}

export type EvidenceRetrySummary = { examined: number; completed: number; stopped?: Stop };

/**
 * Finishes pending receipts older than a minute, oldest first, up to ten. One failure does
 * not stop the rest, but a budget or outage report ends the run so the worker does not hammer the AI.
 */
export async function retryPendingEvidence(): Promise<EvidenceRetrySummary> {
  const rows = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.verification, "pending"), lt(receipts.createdAt, sql`now() - make_interval(secs => ${RETRY_AFTER_SECONDS})`)))
    .orderBy(asc(receipts.createdAt))
    .limit(RETRY_BATCH);
  const summary: EvidenceRetrySummary = { examined: 0, completed: 0 };
  for (const { id } of rows) {
    summary.examined++;
    try {
      const run = await runEvidence(id);
      if (run.stop) {
        summary.stopped = run.stop;
        break;
      }
      if (run.result.verification !== "pending") summary.completed++;
    } catch (e) {
      console.error(`[vet] evidence retry failed: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
  return summary;
}

// ---------- What a vet sees ----------

export type ExactPlace = { lat: number; lng: number; approximate: boolean } | null;
export type VetCat = { id: string; name: string; sex: string; area: string; exact: ExactPlace };
export type VetBookingRow = {
  id: string;
  catId: string;
  catName: string;
  catStatus: string;
  status: string;
  scheduledFor: string | null;
  packagePrice: number;
  exact: ExactPlace;
};
export type VetDashboard = { fundedCats: VetCat[]; bookings: VetBookingRow[] };

function exactOf(row: { exactLat: number | null; exactLng: number | null; locationApproximate: boolean }): ExactPlace {
  return row.exactLat !== null && row.exactLng !== null
    ? { lat: row.exactLat, lng: row.exactLng, approximate: row.locationApproximate }
    : null;
}

const vetBookingColumns = {
  id: bookings.id,
  catId: bookings.catId,
  catName: cats.name,
  catStatus: cats.status,
  status: bookings.status,
  scheduledFor: bookings.scheduledFor,
  packagePrice: bookings.packagePrice,
  exactLat: cats.exactLat,
  exactLng: cats.exactLng,
  locationApproximate: cats.locationApproximate,
};

type VetBookingColumns = {
  id: string;
  catId: string;
  catName: string;
  catStatus: string;
  status: string;
  scheduledFor: Date | null;
  packagePrice: number;
  exactLat: number | null;
  exactLng: number | null;
  locationApproximate: boolean;
};

const toVetBooking = (b: VetBookingColumns): VetBookingRow => ({
  id: b.id,
  catId: b.catId,
  catName: b.catName,
  catStatus: b.catStatus,
  status: b.status,
  scheduledFor: b.scheduledFor ? manilaDate(b.scheduledFor) : null,
  packagePrice: b.packagePrice,
  exact: exactOf(b),
});

/** For a signed-in vet only. Callers check the role. Holds exact locations, so it is never public or cached. */
export async function listVetDashboard(vetId: string): Promise<VetDashboard> {
  const funded = await db
    .select({
      id: cats.id,
      name: cats.name,
      sex: cats.sex,
      areaName: cats.areaName,
      exactLat: cats.exactLat,
      exactLng: cats.exactLng,
      locationApproximate: cats.locationApproximate,
    })
    .from(cats)
    .where(eq(cats.status, "funded"))
    .orderBy(asc(cats.createdAt));
  const mine = await db
    .select(vetBookingColumns)
    .from(bookings)
    .innerJoin(cats, eq(cats.id, bookings.catId))
    .where(eq(bookings.vetId, vetId))
    .orderBy(desc(bookings.createdAt));
  return {
    fundedCats: funded.map((c) => ({ id: c.id, name: c.name, sex: c.sex, area: c.areaName, exact: exactOf(c) })),
    bookings: mine.map(toVetBooking),
  };
}

export type VetPayout = { kind: string; amount: number; status: string; paypalRef: string | null; date: string };
export type EvidenceState =
  | { state: "open" }
  | { state: "waiting_deposit" }
  | { state: "waiting_cat" }
  | { state: "checking" }
  | { state: "verified" }
  | { state: "closed" };
export type VetBookingView = {
  booking: VetBookingRow;
  payouts: VetPayout[];
  receipt: { verification: Verification; messages: string[]; submitted: string } | null;
  evidence: EvidenceState;
};

function evidenceStateOf(s: BookingState): EvidenceState {
  if (s.latest === "verified") return { state: "verified" };
  if (s.booking.status !== CONFIRMED_BOOKING) return { state: s.booking.status === COMPLETED_BOOKING ? "verified" : "closed" };
  if (s.depositPaid <= 0) return { state: "waiting_deposit" };
  if (s.catStatus !== "in_care") return { state: "waiting_cat" };
  if (s.latest === "pending") return { state: "checking" };
  return { state: "open" };
}

/** Null unless this booking is the vet's. Field by field, so no storage key, hash or model text can reach the page. */
export async function getVetBooking(vetId: string, bookingId: string): Promise<VetBookingView | null> {
  const [row] = await db
    .select(vetBookingColumns)
    .from(bookings)
    .innerJoin(cats, eq(cats.id, bookings.catId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.vetId, vetId)));
  if (!row) return null;
  const state = await loadBookingState(db, bookingId);
  if (!state) return null;

  const paid = await db
    .select({
      kind: payouts.kind,
      amount: payouts.amount,
      status: payouts.status,
      paypalRef: payouts.paypalPayoutBatchId,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .where(and(eq(payouts.bookingId, bookingId), eq(payouts.payeeUserId, vetId)))
    .orderBy(asc(payouts.createdAt));
  const [latest] = await db
    .select({ verification: receipts.verification, reasons: receipts.reasons, createdAt: receipts.createdAt })
    .from(receipts)
    .where(eq(receipts.bookingId, bookingId))
    .orderBy(desc(receipts.createdAt))
    .limit(1);

  return {
    booking: toVetBooking(row),
    payouts: paid.map((p) => ({
      kind: p.kind,
      amount: p.amount,
      status: p.status,
      paypalRef: p.paypalRef,
      date: manilaDate(p.createdAt),
    })),
    receipt: latest
      ? {
          verification: latest.verification as Verification,
          messages: reasonMessages(latest.reasons),
          submitted: manilaDate(latest.createdAt),
        }
      : null,
    evidence: evidenceStateOf(state),
  };
}
