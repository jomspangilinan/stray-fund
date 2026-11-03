import { and, eq } from "drizzle-orm";
import type { Tx } from "./db/client";
import { payouts } from "./db/schema";

/** Leads last_gateway_error when PayPal has said the batch exists. Refuses not_paid and any new payout. */
export const BATCH_EXISTS_FLAG = "BATCH_EXISTS";
/** One first try plus the single retry the agent is allowed. */
export const MAX_FAILED_PAYOUTS = 2;

export type PayoutHistory = {
  status: string;
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

/** Caller holds the colony lock when the answer decides a write. */
export async function payoutHistory(tx: Tx, bookingId: string, kind: "deposit" | "balance"): Promise<PayoutHistory[]> {
  return tx
    .select({ status: payouts.status, lastGatewayError: payouts.lastGatewayError, lateSuccessReviewId: payouts.lateSuccessReviewId, retryClearedBy: payouts.retryClearedBy })
    .from(payouts)
    .where(and(eq(payouts.bookingId, bookingId), eq(payouts.kind, kind)));
}
