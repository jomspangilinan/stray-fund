import { and, eq, sql } from "drizzle-orm";
import { db, withColonyLock } from "./db/client";
import { agentActions, cats } from "./db/schema";
import { SEX_ANSWERED } from "./privateActions";
import { RATE_LIMIT_PER_MINUTE, RateLimited } from "./spot";

/*
 * Anyone signed in may say whether a cat is a girl or a boy, but only while the card does not say. The
 * first answer sets it and a later, different one is ignored. A caretaker's record (cat_set_details) writes
 * the column directly and always wins, before or after, and saving the card confirms the sex. Until then the
 * answer is marked unconfirmed: it shows on the card and gives the ribbon, but funding order and every other
 * money or agent decision treats the cat as sex unknown (see effectiveSex).
 */

export type SexAnswer = "female" | "male";
export const SEX_ANSWERS: readonly string[] = ["female", "male"];

/**
 * Refuses a person who has set too many sexes in the last minute. Counts the audit rows of real changes,
 * so repeating an answer is free. Checked before any lock, so a flood is cheap to turn away.
 */
export async function assertUnderSexLimit(userId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    select count(*)::int as n from agent_actions
    where action = ${SEX_ANSWERED} and inputs->>'userId' = ${userId} and created_at > now() - interval '1 minute'
  `);
  if ((rows[0] as { n: number }).n >= RATE_LIMIT_PER_MINUTE) throw new RateLimited();
}

/**
 * Sets the sex only while it is unknown, and says what the sex is now, so the screen can show the truth
 * when a different answer came first. Null means there is no such cat. A real change leaves a private audit
 * row holding who answered; the public feed leaves this action out.
 */
export async function answerSex(catId: string, userId: string, answer: SexAnswer): Promise<"female" | "male" | "unknown" | null> {
  const [seen] = await db.select({ sex: cats.sex }).from(cats).where(eq(cats.id, catId));
  if (!seen) return null;
  // Already settled, by this answer or another: nothing to write and no lock to take.
  if (seen.sex !== "unknown") return seen.sex as "female" | "male";
  return withColonyLock(async (tx) => {
    const [row] = await tx
      .update(cats)
      .set({ sex: answer, sexUnconfirmed: true })
      .where(and(eq(cats.id, catId), eq(cats.sex, "unknown")))
      .returning({ sex: cats.sex });
    if (!row) {
      const [now] = await tx.select({ sex: cats.sex }).from(cats).where(eq(cats.id, catId));
      return (now?.sex as "female" | "male" | "unknown" | undefined) ?? null;
    }
    await tx.insert(agentActions).values({
      action: SEX_ANSWERED,
      inputs: { catId, userId, from: "unknown", to: answer },
      reason: "A neighbour said whether a cat is a girl or a boy.",
      status: "done",
    });
    return answer;
  });
}
