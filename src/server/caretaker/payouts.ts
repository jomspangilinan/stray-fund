import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { payouts } from "../db/schema";
import { approvePayout, rejectPayout, resolveNeedsReview, type GateResult } from "../moneyGate";
import { restPayoutGateway, type PayoutGateway } from "../paypal/payouts";
import { audit, reqText, reqUuid, Refusal, type Handler } from "./shared";

let override: PayoutGateway | null = null;
/** Tests only. */
export function setGatewayForTests(gw: PayoutGateway | null): void {
  override = gw;
}

const STATUS_WORDS: Record<string, string> = {
  awaiting_approval: "waiting for approval",
  queued: "being sent",
  sent: "sent, waiting for PayPal",
  succeeded: "paid",
  failed: "failed",
  needs_review: "under review",
  rejected: "rejected",
};
const words = (status: string) => STATUS_WORDS[status] ?? status;

/** The gate's messages are written in code, never from input, so they are shown as they are. */
async function gate(run: () => Promise<GateResult>): Promise<GateResult> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Error && /^Payout not found/.test(e.message)) throw new Refusal(404, "There is no such payout.");
    if (e instanceof Error && /^(Cannot|That PayPal|A (paid|not_paid))/.test(e.message)) throw new Refusal(409, `${e.message}.`);
    throw e;
  }
}

export const payoutApprove: Handler = async (caretakerId, body) => {
  const payoutId = reqUuid(body, "payoutId", "The payout");
  const r = await gate(() => approvePayout(payoutId, caretakerId, override ?? restPayoutGateway));
  if (r.status === "rejected" && r.code) {
    throw new Refusal(409, `The spending rules refuse this payout now: ${r.message} Nothing was paid.`);
  }
  if (r.status === "rejected") throw new Refusal(409, "This payout was already rejected.");
  if (r.status === "failed") return "Approved, but PayPal did not take the payment. The treasurer will look at it.";
  if (r.status === "needs_review") return "Approved, but we could not confirm the send. It is now under review.";
  return `Approved. The payment is ${words(r.status)}.`;
};

export const payoutReject: Handler = async (caretakerId, body) => {
  const payoutId = reqUuid(body, "payoutId", "The payout");
  const reason = reqText(body, "reason", "A reason", 300);
  const r = await gate(() => rejectPayout(payoutId, caretakerId, reason));
  if (r.status !== "rejected") throw new Refusal(409, `This payout is ${words(r.status)}, so it cannot be rejected.`);
  return "Rejected. Nothing was paid, and the money is free again.";
};

export const payoutResolve: Handler = async (caretakerId, body) => {
  const payoutId = reqUuid(body, "payoutId", "The payout");
  const outcome = body.outcome;
  if (outcome !== "paid" && outcome !== "not_paid") throw new Refusal(400, "Say whether the payment was paid or not paid.");
  const resolution =
    outcome === "paid"
      ? ({ outcome, paypalRef: reqText(body, "paypalRef", "A PayPal reference", 120) } as const)
      : ({ outcome, note: reqText(body, "note", "A note", 500) } as const);

  const [row] = await db.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, payoutId));
  if (!row) throw new Refusal(404, "There is no such payout.");
  if (row.status !== "needs_review") throw new Refusal(409, `This payout is ${words(row.status)}, not under review.`);

  const r = await gate(() => resolveNeedsReview(payoutId, caretakerId, resolution));
  if (r.status !== "succeeded" && r.status !== "failed") {
    throw new Refusal(409, `This payout is ${words(r.status)}, not under review.`);
  }
  return outcome === "paid" ? "Recorded as paid." : "Recorded as not paid. The money is free again.";
};

/** For a payout that has been sent a long while. It moves nothing. */
export const payoutNote: Handler = async (caretakerId, body) => {
  const payoutId = reqUuid(body, "payoutId", "The payout");
  const note = reqText(body, "note", "A note", 500);
  const [p] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!p) throw new Refusal(404, "There is no such payout.");
  await db.transaction((tx) =>
    audit(tx, {
      action: "payout_note",
      caretakerId,
      reason: "A caretaker added a note to a payment.",
      inputs: { payoutId, catId: p.catId, note },
      amount: p.amount,
    }),
  );
  return "Note saved.";
};
