import { and, eq } from "drizzle-orm";
import type { Tx } from "./db/client";
import { payouts } from "./db/schema";

/** Leads last_gateway_error when PayPal has said the batch exists. Refuses not_paid and any new payout. */
export const BATCH_EXISTS_FLAG = "BATCH_EXISTS";
/** One first try plus the single retry the agent is allowed. */
export const MAX_FAILED_PAYOUTS = 2;

/** PayPal's own words that the money did not leave or came back. Only these free a row that reached PayPal. */
const PROVEN_NOT_PAID = new Set(["FAILED", "RETURNED", "REFUNDED", "CANCELED"]);
/** Errors that say nothing about whether PayPal took the payout. */
const UNKNOWN_OUTCOME = /^Retries exhausted|with no batch id$/;

/**
 * Whether a payout may have reached PayPal, so its money may have left: more than one send attempt, a status PayPal
 * reported, a batch id, or an error that does not say the send was refused. "No batch id" proves nothing, because a
 * first send can time out after PayPal took it and a second attempt can then be refused. A row with one attempt and a
 * definite refusal, no payee email, or no send at all is safe.
 */
export function mayHaveReachedPayPal(p: {
  attempts: number;
  paypalPayoutBatchId: string | null;
  paypalItemStatus: string | null;
  lastGatewayError: string | null;
}): boolean {
  return (
    p.attempts > 1 ||
    p.paypalItemStatus !== null ||
    p.paypalPayoutBatchId !== null ||
    (p.lastGatewayError !== null && (p.lastGatewayError.startsWith(BATCH_EXISTS_FLAG) || UNKNOWN_OUTCOME.test(p.lastGatewayError)))
  );
}

export type PayoutHistory = {
  status: string;
  attempts: number;
  paypalPayoutBatchId: string | null;
  paypalItemStatus: string | null;
  lastGatewayError: string | null;
  lateSuccessReviewId: string | null;
  /** Set when a caretaker allowed a new try on this row. */
  retryClearedBy: string | null;
};

/**
 * Why a new payout for this booking and kind may not be created, if so. Money may have left on a flagged row, a
 * caretaker has said no on a rejected one, and two refusals in a row are a problem one more try will not solve.
 * All need a person. A late SUCCESS blocks for good, like BATCH_EXISTS: closing its question does not lift it,
 * because a new row means a new sender_batch_id and a second payment. Only a caretaker's "Not paid" ruling on the
 * payout clears the pointer.
 */
export function retryBlock(history: PayoutHistory[]): string | undefined {
  if (history.some((p) => p.lastGatewayError?.startsWith(BATCH_EXISTS_FLAG))) {
    return "PayPal reported a batch for an earlier try, so money may have left.";
  }
  if (history.some((p) => p.lateSuccessReviewId)) {
    return "PayPal later reported SUCCESS for an earlier try that was marked failed, so the vet may already be paid. A caretaker must settle it on the desk.";
  }
  // A rejected or failed row that may have reached PayPal needs PayPal's own word that the money did not leave.
  // A caretaker's "new try" can never have been given to such a row, so no cleared row is skipped here.
  if (history.some((p) => (p.status === "failed" || p.status === "rejected") && mayHaveReachedPayPal(p) && !PROVEN_NOT_PAID.has(p.paypalItemStatus ?? ""))) {
    return "An earlier try may have reached PayPal, so the vet may already be paid. A developer must close it.";
  }
  // A row a caretaker cleared no longer counts against the booking. It can only have been cleared with no batch at
  // PayPal, no BATCH_EXISTS and no late SUCCESS, which the checks above would have caught anyway.
  const counted = history.filter((p) => !p.retryClearedBy);
  if (counted.some((p) => p.status === "rejected")) {
    return "An earlier payout for this booking was rejected on review. A caretaker can allow a new try.";
  }
  if (counted.filter((p) => p.status === "failed").length >= MAX_FAILED_PAYOUTS) {
    return "This payout has already failed twice.";
  }
  return undefined;
}

export const PAYOUT_HISTORY_COLUMNS = {
  status: payouts.status,
  attempts: payouts.attempts,
  paypalPayoutBatchId: payouts.paypalPayoutBatchId,
  paypalItemStatus: payouts.paypalItemStatus,
  lastGatewayError: payouts.lastGatewayError,
  lateSuccessReviewId: payouts.lateSuccessReviewId,
  retryClearedBy: payouts.retryClearedBy,
};

/** Caller holds the colony lock when the answer decides a write. */
export async function payoutHistory(tx: Tx, bookingId: string, kind: "deposit" | "balance"): Promise<PayoutHistory[]> {
  return tx
    .select(PAYOUT_HISTORY_COLUMNS)
    .from(payouts)
    .where(and(eq(payouts.bookingId, bookingId), eq(payouts.kind, kind)));
}
