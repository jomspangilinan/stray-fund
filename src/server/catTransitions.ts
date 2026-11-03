import { eq } from "drizzle-orm";
import { canTransition, type CatStatus } from "@/lib/catState";
import { db, type Tx } from "./db/client";
import { cats, payouts } from "./db/schema";

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

/**
 * A deposit that has gone out means the cat is in care. Deterministic and idempotent,
 * so a repeat or a late event never moves a cat that has already moved on, and a
 * failed payout never moves it back.
 */
export async function syncCatForPayout(payoutId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, payoutId));
    if (!payout || payout.kind !== "deposit") return;
    if (payout.status !== "sent" && payout.status !== "succeeded") return;
    const [cat] = await tx
      .select({ status: cats.status })
      .from(cats)
      .where(eq(cats.id, payout.catId))
      .for("update");
    if (cat?.status === "booked") await transitionCat(tx, payout.catId, "in_care");
  });
}
