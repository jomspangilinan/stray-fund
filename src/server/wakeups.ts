import type { Tx } from "./db/client";
import { wakeups } from "./db/schema";

/** Queues a wakeup for the agent. Call inside the transaction that caused it. */
export async function enqueueWakeup(tx: Tx, kind: string, payload: object): Promise<void> {
  await tx.insert(wakeups).values({ kind, payload });
}
