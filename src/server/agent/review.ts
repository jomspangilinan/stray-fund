import { and, eq, sql } from "drizzle-orm";
import { lockColony, type Tx } from "../db/client";
import { agentActions, reviewRequests } from "../db/schema";
import { enqueueWakeup } from "../wakeups";

export const REVIEW_ACTION = "caretaker_review";
const OPEN = "open";
export const RESOLVED = "resolved";

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

/**
 * A caretaker closes an open request. Conditional on it still being open, so a second click
 * changes nothing, and it updates the action row that the public feed reads. The note stays
 * private. Returns false when the request was not open. Under the colony lock, like fileReview.
 */
export async function resolveReview(
  tx: Tx,
  reviewId: string,
  caretakerId: string,
  resolution: string,
  opts: { wakeup?: boolean } = {},
): Promise<boolean> {
  await lockColony(tx);
  const closed = await tx
    .update(reviewRequests)
    .set({ status: RESOLVED, resolvedBy: caretakerId, resolvedAt: sql`now()`, resolution })
    .where(and(eq(reviewRequests.id, reviewId), eq(reviewRequests.status, OPEN)))
    .returning({ id: reviewRequests.id });
  if (closed.length === 0) return false;
  await tx
    .update(agentActions)
    .set({ status: RESOLVED, approvedBy: caretakerId })
    .where(
      and(
        eq(agentActions.action, REVIEW_ACTION),
        sql`${agentActions.inputs}->>'reviewRequestId' = ${reviewId}`,
        eq(agentActions.status, OPEN),
      ),
    );
  if (opts.wakeup ?? true) await enqueueWakeup(tx, "review_resolved", { reviewId });
  return true;
}

/** Closes the open request about a subject, if there is one. A caretaker acting on the subject answers it. */
export async function resolveReviewBySubject(
  tx: Tx,
  subject: string,
  caretakerId: string,
  resolution: string,
): Promise<void> {
  await lockColony(tx);
  const rows = await tx
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.status, OPEN), sql`lower(trim(${reviewRequests.subject})) = lower(${subject.trim()})`));
  for (const { id } of rows) await resolveReview(tx, id, caretakerId, resolution, { wakeup: false });
}
