import { and, eq } from "drizzle-orm";
import { canTransition, type CatStatus } from "@/lib/catState";
import { db, type Tx } from "./db/client";
import { bookings, cats, payouts } from "./db/schema";
import { CONFIRMED_BOOKING } from "./guardrails";

export class IllegalTransition extends Error {
  constructor(
    public readonly from: CatStatus,
    public readonly to: CatStatus,
  ) {
    super(`Illegal cat transition: ${from} -> ${to}`);
    this.name = "IllegalTransition";
  }
}

/** The only way a cat's status changes. Locks the row for the transaction. */
export async function transitionCat(
  tx: Tx,
  catId: string,
  to: CatStatus,
): Promise<void> {
  const [cat] = await tx
    .select({ status: cats.status })
    .from(cats)
    .where(eq(cats.id, catId))
    .for("update");
  if (!cat) throw new Error(`Cat not found: ${catId}`);
  const from = cat.status as CatStatus;
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  await tx.update(cats).set({ status: to }).where(eq(cats.id, catId));
}

export const COMPLETED_BOOKING = "completed";

/**
 * A booking stays confirmed until its balance has succeeded, because the gate refuses
 * a balance on anything else. A balance that later came back reopens the booking, so
 * that it can be paid again, unless another balance for it has succeeded.
 */
async function syncBookingForBalance(tx: Tx, payout: typeof payouts.$inferSelect): Promise<void> {
  if (payout.status === "succeeded") {
    await tx
      .update(bookings)
      .set({ status: COMPLETED_BOOKING })
      .where(and(eq(bookings.id, payout.bookingId), eq(bookings.status, CONFIRMED_BOOKING)));
    return;
  }
  if (payout.status !== "failed") return;
  const [paid] = await tx
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.bookingId, payout.bookingId), eq(payouts.kind, "balance"), eq(payouts.status, "succeeded")))
    .limit(1);
  if (paid) return;
  await tx
    .update(bookings)
    .set({ status: CONFIRMED_BOOKING })
    .where(and(eq(bookings.id, payout.bookingId), eq(bookings.status, COMPLETED_BOOKING)));
}

/**
 * A deposit that has gone out means the cat is in care, and a balance that has succeeded
 * completes the booking. Deterministic and idempotent, so a repeat or a late event never
 * moves a cat that has already moved on, and a failed payout never moves it back.
 */
export async function syncCatForPayout(payoutId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, payoutId));
    if (!payout) return;
    if (payout.kind === "balance") return syncBookingForBalance(tx, payout);
    if (payout.status !== "sent" && payout.status !== "succeeded") return;
    const [cat] = await tx
      .select({ status: cats.status })
      .from(cats)
      .where(eq(cats.id, payout.catId))
      .for("update");
    if (cat?.status === "booked") await transitionCat(tx, payout.catId, "in_care");
  });
}
