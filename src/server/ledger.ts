import { sql } from "drizzle-orm";
import type { Tx } from "./db/client";
import { allocations } from "./db/schema";

export type Allocation = typeof allocations.$inferSelect;

/** Donation status meaning the money has been captured. Others count nowhere. */
export const CAPTURED = "captured";

const ALLOCATION_PURPOSE = "vet";

export type PoolStatus = {
  grossIn: number;
  paypalFees: number;
  vetPaid: number;
  payoutFees: number;
  heldForCats: number;
  reservedPayouts: number;
  /** Can be below zero: money PayPal took back after it was given to cats or paid out. */
  available: number;
  /** Gross PayPal took back (refunds, reversals, denials). Already taken off grossIn, fees and available. */
  reversedGross: number;
};

export class InsufficientFunds extends Error {
  constructor(
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Insufficient funds: requested ${requested}, available ${available}`);
    this.name = "InsufficientFunds";
  }
}

/** Postgres returns bigint sums as strings; convert and refuse unsafe values. */
export function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Amount is not a safe integer: ${String(value)}`);
  }
  return n;
}

function assertPositiveInt(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Amount must be a positive integer of centavos, got ${amount}`);
  }
}

/**
 * Every figure is derived from SQL aggregates, never stored running balances. Refunds, reversals and denials are
 * their own rows (donation_reversals) and count only while their donation is captured, so the donation row itself
 * is never edited. A pool below zero is shown as it is: nothing is clawed back and no figure is clamped here.
 */
export async function getPoolStatus(tx: Tx): Promise<PoolStatus> {
  const result = await tx.execute(sql`
    select
      (select coalesce(sum(gross), 0)::bigint from donations where status = ${CAPTURED})
        + (select coalesce(sum(r.gross_delta), 0)::bigint from donation_reversals r
           join donations d on d.id = r.donation_id where d.status = ${CAPTURED}) as gross_in,
      (select coalesce(sum(paypal_fee), 0)::bigint from donations where status = ${CAPTURED})
        + (select coalesce(sum(r.fee_delta), 0)::bigint from donation_reversals r
           join donations d on d.id = r.donation_id where d.status = ${CAPTURED}) as paypal_fees,
      (select coalesce(sum(net), 0)::bigint from donations where status = ${CAPTURED})
        + (select coalesce(sum(r.net_delta), 0)::bigint from donation_reversals r
           join donations d on d.id = r.donation_id where d.status = ${CAPTURED}) as net_in,
      (select coalesce(-sum(r.gross_delta), 0)::bigint from donation_reversals r
         join donations d on d.id = r.donation_id where d.status = ${CAPTURED}) as reversed_gross,
      (select coalesce(sum(a.amount), 0)::bigint
         from allocations a join donations d on d.id = a.donation_id
         where d.status = ${CAPTURED}) as alloc_net,
      (select coalesce(sum(amount), 0)::bigint from payouts where status = 'succeeded') as vet_paid,
      (select coalesce(sum(fee), 0)::bigint from payouts where status = 'succeeded') as payout_fees,
      (select coalesce(sum(amount), 0)::bigint from payouts
         where status in ('awaiting_approval', 'queued', 'sent', 'needs_review')) as reserved
  `);
  const row = result.rows[0] as Record<string, unknown>;
  const grossIn = toInt(row.gross_in);
  const paypalFees = toInt(row.paypal_fees);
  const netIn = toInt(row.net_in);
  const allocNet = toInt(row.alloc_net);
  const vetPaid = toInt(row.vet_paid);
  const payoutFees = toInt(row.payout_fees);
  const reservedPayouts = toInt(row.reserved);
  return {
    grossIn,
    paypalFees,
    vetPaid,
    payoutFees,
    heldForCats: allocNet - vetPaid - reservedPayouts,
    reservedPayouts,
    available: netIn - allocNet - payoutFees,
    reversedGross: toInt(row.reversed_gross),
  };
}

/** Caller must hold withColonyLock. Draws FIFO from donations with unallocated net. */
export async function allocateToCat(
  tx: Tx,
  catId: string,
  amount: number,
): Promise<Allocation[]> {
  assertPositiveInt(amount);
  const { available } = await getPoolStatus(tx);
  if (amount > available) throw new InsufficientFunds(amount, available);

  const result = await tx.execute(sql`
    select d.id as donation_id,
           (d.net - coalesce(sum(a.amount), 0)
              + (select coalesce(sum(r.net_delta), 0) from donation_reversals r where r.donation_id = d.id))::bigint as remaining
    from donations d
    left join allocations a on a.donation_id = d.id
    where d.status = ${CAPTURED}
    group by d.id, d.net, d.created_at
    having d.net - coalesce(sum(a.amount), 0)
             + (select coalesce(sum(r.net_delta), 0) from donation_reversals r where r.donation_id = d.id) > 0
    order by d.created_at asc, d.id asc
  `);

  const draws: { donationId: string; amount: number }[] = [];
  let left = amount;
  for (const r of result.rows as { donation_id: string; remaining: unknown }[]) {
    if (left === 0) break;
    const take = Math.min(left, toInt(r.remaining));
    draws.push({ donationId: r.donation_id, amount: take });
    left -= take;
  }
  if (left > 0) throw new InsufficientFunds(amount, amount - left);

  return tx
    .insert(allocations)
    .values(draws.map((d) => ({ ...d, catId, purpose: ALLOCATION_PURPOSE })))
    .returning();
}

/** What each donation still holds for this cat, newest first, and how much of it no payout has claimed. */
async function heldForCat(
  tx: Tx,
  catId: string,
): Promise<{ rows: { donation_id: string; held: unknown }[]; unspent: number }> {
  const result = await tx.execute(sql`
    select a.donation_id, sum(a.amount)::bigint as held
    from allocations a
    join donations d on d.id = a.donation_id
    where a.cat_id = ${catId}
    group by a.donation_id, d.created_at
    having sum(a.amount) > 0
    order by d.created_at desc, a.donation_id desc
  `);

  const rows = result.rows as { donation_id: string; held: unknown }[];
  const catNet = rows.reduce((s, r) => s + toInt(r.held), 0);
  // Money tied to a succeeded or live payout can never return to the pool.
  const committed = await tx.execute(sql`
    select coalesce(sum(amount), 0)::bigint as committed from payouts
    where cat_id = ${catId}
      and status in ('succeeded', 'awaiting_approval', 'queued', 'sent', 'needs_review')
  `);
  return { rows, unspent: catNet - toInt((committed.rows[0] as { committed: unknown }).committed) };
}

/** Caller must hold withColonyLock. How much returnSurplus could give back for this cat. */
export async function unspentForCat(tx: Tx, catId: string): Promise<number> {
  return (await heldForCat(tx, catId)).unspent;
}

/** Caller must hold withColonyLock. Writes negative rows, newest donations first. */
export async function returnSurplus(
  tx: Tx,
  catId: string,
  amount: number,
): Promise<void> {
  assertPositiveInt(amount);
  const { rows, unspent } = await heldForCat(tx, catId);
  if (amount > unspent) {
    throw new Error(`Cannot return ${amount}: cat has only ${unspent} unspent`);
  }

  const returns: { donationId: string; amount: number }[] = [];
  let left = amount;
  for (const r of rows) {
    if (left === 0) break;
    const give = Math.min(left, toInt(r.held));
    returns.push({ donationId: r.donation_id, amount: -give });
    left -= give;
  }
  await tx
    .insert(allocations)
    .values(returns.map((d) => ({ ...d, catId, purpose: ALLOCATION_PURPOSE })));
}
