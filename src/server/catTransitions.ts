import { eq } from "drizzle-orm";
import { canTransition, type CatStatus } from "@/lib/catState";
import type { Tx } from "./db/client";
import { cats } from "./db/schema";

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
