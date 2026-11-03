import { and, eq, sql } from "drizzle-orm";
import { fileReview } from "./agent/review";
import { MoneyAlreadyMoved, markAlreadyNeutered, transitionCat } from "./catTransitions";
import { db, withColonyLock, type Tx } from "./db/client";
import { agentActions, cats, earTipFlags } from "./db/schema";
import { EAR_TIP_ANSWERED } from "./privateActions";
import { RATE_LIMIT_PER_MINUTE, RateLimited } from "./spot";
import { enqueueWakeup } from "./wakeups";

/*
 * People, not the AI, say whether a cat has a tipped ear. Spotters and neighbours answer Yes or No, and the
 * answer is a flag on the cat. Flags never move money: they can only queue a cat or call it already neutered,
 * and a caretaker settles anything the flags cannot.
 */

export type EarTipValue = "yes" | "no";
/** How many different people have said each. A person has one answer per cat. */
export type EarTipCounts = { yes: number; no: number };

/** Different people who must agree before the flags settle a cat. */
export const AGREEING_FLAGS = 2;

export const WAITING_STATUSES = ["queued", "funded", "booked", "in_care"] as const;

export const disagreementSubject = (catId: string) => `People disagree on the ear-tip of cat ${catId}`;
export const lateYesSubject = (catId: string) => `Someone saw an ear-tip on cat ${catId} after it was queued`;

/** What two matching answers, or none, do to a spotted cat. Pure, so the rule is easy to test on its own. */
export function verdictFor(c: EarTipCounts): "none" | "queue" | "neutered" | "review" {
  if (c.yes > 0 && c.no > 0) return "review";
  if (c.no >= AGREEING_FLAGS) return "queue";
  if (c.yes >= AGREEING_FLAGS) return "neutered";
  return "none";
}

export async function countFlags(tx: Pick<Tx, "select">, catId: string): Promise<EarTipCounts> {
  const rows = await tx
    .select({ value: earTipFlags.value, n: sql<number>`count(*)::int` })
    .from(earTipFlags)
    .where(eq(earTipFlags.catId, catId))
    .groupBy(earTipFlags.value);
  return { yes: rows.find((r) => r.value === "yes")?.n ?? 0, no: rows.find((r) => r.value === "no")?.n ?? 0 };
}

/**
 * The one place the queue rule lives. Caller holds the colony lock and runs it in the same
 * transaction as the flag change, so two people answering at once cannot both miss the second answer.
 *  - spotted: two people saying No queue the cat; two saying Yes make it already neutered, unless
 *    money is set aside, when a person looks; any Yes with any No files one review and changes nothing.
 *  - queued up to in care: the status never moves, but a Yes files a review, since someone may have seen a tip.
 *  - neutered or later: nothing to decide.
 */
export async function applyEarTipRule(tx: Tx, catId: string, changed: EarTipValue | null): Promise<void> {
  const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
  if (!cat) return;

  if (cat.status === "spotted") {
    const verdict = verdictFor(await countFlags(tx, catId));
    if (verdict === "review") {
      await fileReview(tx, disagreementSubject(catId), `People gave different answers about ${cat.name}'s ear-tip. Please look and decide.`);
    } else if (verdict === "queue") {
      await tx.update(cats).set({ earTipped: false, queuedAt: new Date() }).where(eq(cats.id, catId));
      await transitionCat(tx, catId, "queued");
      await enqueueWakeup(tx, "cat_queued", { catId });
    } else if (verdict === "neutered") {
      try {
        // Savepoint, so a refusal leaves the transaction usable for the review.
        await tx.transaction((inner) => markAlreadyNeutered(inner, catId));
      } catch (e) {
        if (!(e instanceof MoneyAlreadyMoved)) throw e;
        await fileReview(tx, disagreementSubject(catId), `Two people say ${cat.name} has an ear-tip, but money is already set aside for it. Please look and decide.`);
      }
    }
    return;
  }

  if ((WAITING_STATUSES as readonly string[]).includes(cat.status) && changed === "yes") {
    await fileReview(tx, lateYesSubject(catId), `A person says ${cat.name} has an ear-tip, but it is already in the queue or in care. Please look and decide.`);
  }
}

async function currentAnswer(tx: Pick<Tx, "select">, catId: string, userId: string): Promise<EarTipValue | null> {
  const [row] = await tx
    .select({ value: earTipFlags.value })
    .from(earTipFlags)
    .where(and(eq(earTipFlags.catId, catId), eq(earTipFlags.userId, userId)));
  return (row?.value as EarTipValue | undefined) ?? null;
}

/**
 * Refuses a person who has changed answers too often in the last minute. Checked before the colony lock is
 * taken, so a flood is cheap to turn away. It counts the audit rows of real moves, so repeating an answer is free.
 */
export async function assertUnderFlagLimit(userId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    select count(*)::int as n from agent_actions
    where action = ${EAR_TIP_ANSWERED} and inputs->>'userId' = ${userId} and created_at > now() - interval '1 minute'
  `);
  if ((rows[0] as { n: number }).n >= RATE_LIMIT_PER_MINUTE) throw new RateLimited();
}

/**
 * Writes or removes one person's answer, then runs the rule. Caller holds the colony lock. Saying what the
 * person already said changes nothing. A real move leaves an audit row for the rate limit. It holds the person's id
 * and is private: the public feed leaves this action out, so no answer activity is ever shown.
 */
export async function setEarTipFlagIn(tx: Tx, catId: string, userId: string, value: EarTipValue | null): Promise<void> {
  const before = await currentAnswer(tx, catId, userId);
  if (before === value) return;
  if (value === null) {
    await tx.delete(earTipFlags).where(and(eq(earTipFlags.catId, catId), eq(earTipFlags.userId, userId)));
  } else {
    await tx
      .insert(earTipFlags)
      .values({ catId, userId, value })
      .onConflictDoUpdate({ target: [earTipFlags.catId, earTipFlags.userId], set: { value, createdAt: sql`now()` } });
  }
  await tx.insert(agentActions).values({
    action: EAR_TIP_ANSWERED,
    inputs: { catId, userId, from: before, to: value },
    reason: "A neighbour answered about a cat's ear-tip.",
    status: "done",
  });
  await applyEarTipRule(tx, catId, value);
}

/**
 * One person's answer about one cat, in its own transaction. Null is Not sure and takes an earlier answer back.
 * An answer that is already on record returns before the lock is taken.
 */
export async function setEarTipFlag(catId: string, userId: string, value: EarTipValue | null): Promise<void> {
  if ((await currentAnswer(db, catId, userId)) === value) return;
  await withColonyLock((tx) => setEarTipFlagIn(tx, catId, userId, value));
}

/** The caller's own answers only, for the cat card, the reveal and the missions. Never anyone else's. */
export async function ownFlags(tx: Pick<Tx, "select">, userId: string, catIds: string[]): Promise<Map<string, EarTipValue>> {
  const out = new Map<string, EarTipValue>();
  if (catIds.length === 0) return out;
  const rows = await tx
    .select({ catId: earTipFlags.catId, value: earTipFlags.value })
    .from(earTipFlags)
    .where(and(eq(earTipFlags.userId, userId), sql`${earTipFlags.catId} in (${sql.join(catIds.map((c) => sql`${c}::uuid`), sql`, `)})`));
  for (const r of rows) out.set(r.catId, r.value as EarTipValue);
  return out;
}
