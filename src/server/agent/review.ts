import { and, eq, sql } from "drizzle-orm";
import { lockColony, type Tx } from "../db/client";
import { agentActions, reviewRequests } from "../db/schema";

export const REVIEW_ACTION = "caretaker_review";
const OPEN = "open";

/**
 * Puts a question on the caretaker queue and records it. Moves no money. An open
 * request with the same subject, ignoring case and surrounding space, absorbs the
 * new one. The colony lock makes that check safe with no unique index.
 */
export async function fileReview(
  tx: Tx,
  subject: string,
  reason: string,
): Promise<{ id: string; deduplicated: boolean }> {
  await lockColony(tx);
  const clean = subject.trim();
  const [open] = await tx
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.status, OPEN),
        sql`lower(trim(${reviewRequests.subject})) = lower(${clean})`,
      ),
    )
    .limit(1);
  if (open) return { id: open.id, deduplicated: true };

  const [request] = await tx.insert(reviewRequests).values({ subject: clean, reason }).returning();
  await tx.insert(agentActions).values({
    action: REVIEW_ACTION,
    inputs: { reviewRequestId: request.id, subject: clean },
    reason,
    status: OPEN,
  });
  return { id: request.id, deduplicated: false };
}
