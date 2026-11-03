import { eq, sql, type SQL } from "drizzle-orm";
import type { Tx } from "./db/client";
import {
  allowedPayees,
  bookings,
  guardrails,
  receipts,
  users,
} from "./db/schema";
import { CAPTURED, getPoolStatus, toInt } from "./ledger";

export type GuardrailCode =
  | "PAYEE_NOT_ALLOWED"
  | "OVER_CAT_CAP"
  | "OVER_DAY_CAP"
  | "OVER_ALLOCATION"
  | "RECEIPT_NOT_VERIFIED"
  | "DEPOSIT_NOT_PAID"
  | "DUPLICATE_PAYOUT"
  | "BOOKING_NOT_CONFIRMED";

export type SpendRequest = {
  catId: string;
  payeeId: string;
  /** Integer centavos. */
  amount: number;
  kind: "deposit" | "balance";
  receiptId?: string;
  bookingId: string;
};

export type SpendDenial = { verdict: "deny"; code: GuardrailCode; message: string };
export type SpendVerdict = { verdict: "allow" | "needs_approval" } | SpendDenial;

export type CheckOptions = {
  /**
   * Set when a caretaker approves a waiting payout: skips the approval threshold
   * and leaves that payout out of the cap sums and the duplicate check.
   */
  approvingPayoutId?: string;
};

export const CONFIRMED_BOOKING = "confirmed";

const deny = (code: GuardrailCode, message: string): SpendDenial => ({
  verdict: "deny",
  code,
  message,
});

async function sumCentavos(tx: Tx, query: SQL): Promise<number> {
  const { rows } = await tx.execute(query);
  return toInt((rows[0] as { total: unknown }).total);
}

/**
 * Caller must hold withColonyLock. Every deny check runs before the approval
 * check, so a caretaker is never asked to approve something that cannot be paid.
 */
export async function checkSpend(
  tx: Tx,
  r: SpendRequest,
  opts: CheckOptions = {},
): Promise<SpendVerdict> {
  if (!Number.isSafeInteger(r.amount) || r.amount <= 0) {
    throw new Error(`Amount must be a positive integer of centavos, got ${r.amount}`);
  }

  const excluded = opts.approvingPayoutId;
  const notExcluded = excluded ? sql`and id <> ${excluded}` : sql``;

  const [limits] = await tx.select().from(guardrails).where(eq(guardrails.id, 1));
  if (!limits) throw new Error("Guardrails row is missing");

  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, r.bookingId));
  if (!booking || booking.catId !== r.catId || booking.status !== CONFIRMED_BOOKING) {
    return deny("BOOKING_NOT_CONFIRMED", "This cat has no confirmed booking with that id.");
  }

  const [allowed] = await tx
    .select({ userId: allowedPayees.userId })
    .from(allowedPayees)
    .where(eq(allowedPayees.userId, r.payeeId))
    .limit(1);
  if (!allowed || r.payeeId !== booking.vetId) {
    return deny("PAYEE_NOT_ALLOWED", "The payee is not an allowed payee and this booking's vet.");
  }
  const [payee] = await tx
    .select({ email: users.paypalEmail })
    .from(users)
    .where(eq(users.id, r.payeeId));
  if (!payee?.email) {
    return deny("PAYEE_NOT_ALLOWED", "The payee has no PayPal email on file.");
  }

  const { rows: duplicates } = await tx.execute(sql`
    select 1 from payouts
    where booking_id = ${r.bookingId} and kind = ${r.kind}
      and status not in ('failed', 'rejected') ${notExcluded}
    limit 1
  `);
  if (duplicates.length > 0) {
    return deny("DUPLICATE_PAYOUT", `This booking already has a live ${r.kind} payout.`);
  }

  if (r.kind === "balance") {
    const [receipt] = r.receiptId
      ? await tx.select().from(receipts).where(eq(receipts.id, r.receiptId))
      : [];
    if (!receipt || receipt.bookingId !== r.bookingId || receipt.verification !== "verified") {
      return deny("RECEIPT_NOT_VERIFIED", "A balance needs a verified receipt for this booking.");
    }
    const { rows: deposits } = await tx.execute(sql`
      select 1 from payouts
      where booking_id = ${r.bookingId} and kind = 'deposit' and status = 'succeeded'
      limit 1
    `);
    if (deposits.length === 0) {
      return deny("DEPOSIT_NOT_PAID", "A balance needs a deposit that succeeded for this booking.");
    }
  }

  const catSpent = await sumCentavos(
    tx,
    sql`select coalesce(sum(amount), 0)::bigint as total from payouts
        where cat_id = ${r.catId} and status not in ('failed', 'rejected') ${notExcluded}`,
  );
  if (catSpent + r.amount > limits.maxPerCat) {
    return deny("OVER_CAT_CAP", "This would take the cat over its spending cap.");
  }

  const daySpent = await sumCentavos(
    tx,
    sql`select coalesce(sum(amount), 0)::bigint as total from payouts
        where status not in ('failed', 'rejected')
          and (coalesce(last_attempt_at, created_at) at time zone 'Asia/Manila')::date
            = (now() at time zone 'Asia/Manila')::date
          ${notExcluded}`,
  );
  if (daySpent + r.amount > limits.maxPerDay) {
    return deny("OVER_DAY_CAP", "This would go over today's spending cap.");
  }

  const catAllocation = await sumCentavos(
    tx,
    sql`select coalesce(sum(a.amount), 0)::bigint as total
        from allocations a join donations d on d.id = a.donation_id
        where a.cat_id = ${r.catId} and d.status = ${CAPTURED}`,
  );
  if (catSpent + r.amount > catAllocation) {
    return deny("OVER_ALLOCATION", "This would spend more than the cat has been allocated.");
  }

  // The per-cat check alone misses money gone from the pool as a whole, such as
  // a donation refunded after another cat already spent it.
  const pool = await getPoolStatus(tx);
  const held = pool.heldForCats + (excluded ? r.amount : 0);
  if (r.amount > held) {
    return deny("OVER_ALLOCATION", "The money held for cats cannot cover this payout.");
  }

  if (!excluded && r.amount > limits.approvalThreshold) {
    return { verdict: "needs_approval" };
  }
  return { verdict: "allow" };
}
