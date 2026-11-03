import { and, eq, inArray } from "drizzle-orm";
import { formatPeso, parsePesoInput } from "@/lib/money";
import { resolveReview, resolveReviewBySubject } from "../agent/review";
import { ReceiptSchema, type ReceiptReading } from "../ai/schemas";
import { withColonyLock } from "../db/client";
import { bookings, cats, receipts, reviewRequests } from "../db/schema";
import { CONFIRMED_BOOKING } from "../guardrails";
import { manilaDate } from "../public";
import { enqueueWakeup } from "../wakeups";
import {
  VetFlowError,
  applyVerifiedOutcome,
  assertEarTipPhotoStored,
  confirmEarTipPhoto,
  depositPaidOn,
  receiptDate,
  surplusToReturn,
  surplusUnavailable,
} from "../vetFlow";
import { audit, flag, reqText, reqUuid, requireCaretaker, Refusal, type Handler } from "./shared";

const evidenceSubject = (bookingId: string) => `Evidence on booking ${bookingId} needs a person`;

const BLANK_READING: ReceiptReading = {
  clinic: null,
  date: null,
  total_centavos: null,
  currency: null,
  receipt_number: null,
  cat_name: null,
  items: [],
  tamper_signs: [],
};

/**
 * The one tap a caretaker gives after looking at the vet's photo: "I saw the ear-tip". Only a caretaker can,
 * the vet cannot, and the photo has to exist. The receipt has already passed every check, which are run again
 * here. A pass makes it verified through the same function every verified receipt uses.
 */
export const evidenceConfirmEarTip: Handler = async (caretakerId, body) => {
  const receiptId = reqUuid(body, "receiptId", "The receipt");
  return withColonyLock(async (tx) => {
    await requireCaretaker(tx, caretakerId);
    let out;
    try {
      out = await confirmEarTipPhoto(tx, receiptId);
    } catch (e) {
      if (e instanceof VetFlowError) throw new Refusal(e.status === 404 ? 404 : 409, e.message);
      throw e;
    }
    const [r] = await tx.select({ bookingId: receipts.bookingId }).from(receipts).where(eq(receipts.id, receiptId));
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, r.bookingId));
    if (out.verification !== "verified") {
      return { tone: "warn", message: "The checks no longer pass, so this went to review instead." };
    }
    await audit(tx, {
      action: "ear_tip_confirmed",
      caretakerId,
      reason: "A caretaker confirmed the ear-tip in a vet's photo.",
      inputs: { receiptId, bookingId: booking.id, catId: booking.catId },
    });
    await resolveReviewBySubject(tx, evidenceSubject(booking.id), caretakerId, "Confirmed by a caretaker.");
    return "Confirmed. The cat is marked neutered and the treasurer can now release the balance.";
  });
};

/**
 * A real override of the checks, so it asks for more than a click: the total the caretaker
 * confirms, a note, and a tick that they saw the ear-tip themselves. Everything after that is
 * the same function the checks use, so treatments, neutered status, ear-tip and surplus behave
 * the same. The gate's own ear-tip check is untouched, because the tick is what sets it.
 */
export const evidenceAccept: Handler = async (caretakerId, body) => {
  const receiptId = reqUuid(body, "receiptId", "The receipt");
  const note = reqText(body, "note", "A note", 500);
  if (!flag(body, "earTipConfirmed")) {
    throw new Refusal(400, "Tick the box to confirm you saw the ear-tip in the photo. Without it the receipt cannot be accepted.");
  }
  const total = typeof body.total === "string" || typeof body.total === "number" ? parsePesoInput(String(body.total)) : null;
  if (total === null || total <= 0) throw new Refusal(400, "Enter the receipt total in pesos, such as 1200.");

  return withColonyLock(async (tx) => {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
    if (!r) throw new Refusal(404, "There is no such receipt.");
    if (r.verification !== "needs_review") {
      throw new Refusal(409, "This receipt is no longer waiting for review.");
    }
    try {
      await assertEarTipPhotoStored(r);
    } catch (e) {
      if (e instanceof VetFlowError) throw new Refusal(409, e.message);
      throw e;
    }
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, r.bookingId));
    const [cat] = await tx.select().from(cats).where(eq(cats.id, booking.catId)).for("update");
    if (booking.status !== CONFIRMED_BOOKING) throw new Refusal(409, "This booking is no longer open.");
    if (cat.status !== "in_care") throw new Refusal(409, "This cat is not in care, so the receipt cannot be accepted.");

    const deposit = await depositPaidOn(tx, booking.id);
    if (deposit <= 0) throw new Refusal(409, "The deposit for this booking has not been paid.");
    if (total <= deposit) {
      throw new Refusal(400, `The total must be more than the deposit already paid, ${formatPeso(deposit)}.`);
    }
    if (total > booking.packagePrice) {
      throw new Refusal(400, `The total cannot be more than the package price, ${formatPeso(booking.packagePrice)}.`);
    }
    const [live] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.bookingId, booking.id), inArray(receipts.verification, ["pending", "verified", "awaiting_ear_tip_confirmation"])));
    if (live) throw new Refusal(409, "This booking already has a newer submission.");

    const surplus = surplusToReturn(booking.packagePrice, total);
    if (await surplusUnavailable(tx, cat.id, surplus)) {
      throw new Refusal(409, "The money held for this cat does not match that total. Check the amount.");
    }

    const read = ReceiptSchema.safeParse(r.parsed);
    const original = read.success ? read.data : BLANK_READING;
    // Balances are worked out from this row, so it holds the total the caretaker confirmed.
    const parsed: ReceiptReading = { ...original, total_centavos: total };
    const today = manilaDate(new Date());
    const printed = receiptDate(original.date);
    const treatedOn = printed !== null && printed <= today ? printed : today;

    await tx.update(receipts).set({ verification: "verified", reasons: [], parsed }).where(eq(receipts.id, receiptId));
    await applyVerifiedOutcome(tx, { receiptId, booking, catId: cat.id, parsed, treatedOn, surplus });
    await audit(tx, {
      action: "evidence_accepted",
      caretakerId,
      reason: "A caretaker checked a vet's evidence and accepted it.",
      inputs: {
        receiptId,
        bookingId: booking.id,
        catId: cat.id,
        note,
        total,
        parsedTotal: original.total_centavos,
        earTipConfirmed: true,
        reasons: r.reasons,
      },
    });
    await resolveReviewBySubject(tx, evidenceSubject(booking.id), caretakerId, "Accepted by a caretaker.");
    return "Accepted. The cat is marked neutered and the treasurer can now release the balance.";
  });
};

export const evidenceReject: Handler = async (caretakerId, body) => {
  const receiptId = reqUuid(body, "receiptId", "The receipt");
  const note = reqText(body, "note", "A note", 500);
  return withColonyLock(async (tx) => {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
    if (!r) throw new Refusal(404, "There is no such receipt.");
    if (r.verification !== "needs_review" && r.verification !== "awaiting_ear_tip_confirmation") {
      throw new Refusal(409, "This receipt is no longer waiting for review.");
    }
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, r.bookingId));
    await tx
      .update(receipts)
      .set({ verification: "rejected", reasons: ["caretaker_rejected"] })
      .where(eq(receipts.id, receiptId));
    await enqueueWakeup(tx, "evidence_rejected", { bookingId: booking.id, catId: booking.catId });
    await audit(tx, {
      action: "evidence_rejected",
      caretakerId,
      reason: "A caretaker checked a vet's evidence and did not accept it.",
      inputs: { receiptId, bookingId: booking.id, catId: booking.catId, note },
    });
    await resolveReviewBySubject(tx, evidenceSubject(booking.id), caretakerId, "Not accepted by a caretaker.");
    return "Not accepted. The balance stays unpaid, and the vet can send new evidence.";
  });
};

/** Closes the agent's own question. The caretaker's note stays on the request and is never public. */
export const reviewResolve: Handler = async (caretakerId, body) => {
  const reviewId = reqUuid(body, "reviewId", "The request");
  const resolution = reqText(body, "resolution", "A note", 500);
  const done = await withColonyLock((tx) => resolveReview(tx, reviewId, caretakerId, resolution));
  if (done) return "Closed. The treasurer has been told.";
  const [row] = await withColonyLock((tx) => tx.select().from(reviewRequests).where(eq(reviewRequests.id, reviewId)));
  if (!row) throw new Refusal(404, "There is no such request.");
  throw new Refusal(409, "This request is already closed.");
};
