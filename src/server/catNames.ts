import { and, asc, desc, eq, sql } from "drizzle-orm";
import { parseCatName, pickFreeName } from "@/lib/catNames";
import { db, withColonyLock, type Tx } from "./db/client";
import { agentActions, cats, nameSuggestions, sightings } from "./db/schema";
import { Refusal } from "./caretaker/shared";
import { NAME_ANOTHER, NAME_SUGGESTED } from "./privateActions";
import { RATE_LIMIT_PER_MINUTE, RateLimited } from "./spot";

/*
 * Cat names. The first name comes from the AI or, when that one is taken, from a fixed list of our own. The
 * finder can ask for another one from that list. Anyone signed in can suggest the real name; it stays
 * private until a caretaker approves it. Who asked is never public: not in a read, the feed, thanks or the card.
 */

/** Every cat name in use, as written. The AI is told these so it picks another. */
export async function catNamesInUse(tx: Pick<Tx, "select">): Promise<string[]> {
  return (await tx.select({ name: cats.name }).from(cats).orderBy(asc(cats.name))).map((r) => r.name);
}

/** Every cat name in use, lower case, leaving out the cat that is being renamed. */
export async function takenNames(tx: Pick<Tx, "select">, exceptCatId?: string): Promise<Set<string>> {
  const rows = await tx.select({ id: cats.id, name: cats.name }).from(cats);
  return new Set(rows.filter((r) => r.id !== exceptCatId).map((r) => r.name.toLowerCase()));
}

/**
 * The wanted name if no other cat has it (ignoring case), else a free name from the built-in list, and a number
 * only when that list is used up too. The cat being renamed does not count as holding its own name.
 */
export async function uniqueName(tx: Pick<Tx, "select">, wanted: string, exceptCatId?: string): Promise<string> {
  const taken = await takenNames(tx, exceptCatId);
  return taken.has(wanted.toLowerCase()) ? pickFreeName(taken) : wanted;
}

/** The person whose sighting started the card, or null for a cat nobody's photo started. */
async function finderOf(tx: Pick<Tx, "select">, catId: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: sightings.caughtByUserId })
    .from(sightings)
    .where(and(eq(sightings.catId, catId), eq(sightings.state, "new_cat")))
    .orderBy(asc(sightings.createdAt), asc(sightings.id))
    .limit(1);
  return row?.userId ?? null;
}

/** Another name is open only before funding starts: later, a vet receipt is checked against the cat's name. */
const RENAMABLE_STATUSES: readonly string[] = ["spotted", "queued"];

/** The one rule for Another name on a cat, shared by the button and the server. */
export const anotherNameOpen = (cat: { status: string; nameLocked: boolean }) => !cat.nameLocked && RENAMABLE_STATUSES.includes(cat.status);

/** Whether this person may ask for another name for a cat: its finder, while the cat is spotted or queued and no caretaker has named it. */
export async function canAskForAnotherName(tx: Pick<Tx, "select">, cat: { id: string; status: string; nameLocked: boolean }, userId: string): Promise<boolean> {
  return anotherNameOpen(cat) && (await finderOf(tx, cat.id)) === userId;
}

/**
 * Counts the audit rows of real name moves, like the ear-tip limit. Checked before any lock, so a flood is
 * turned away cheaply.
 */
export async function assertUnderNameLimit(userId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    select count(*)::int as n from agent_actions
    where action in (${NAME_SUGGESTED}, ${NAME_ANOTHER}) and inputs->>'userId' = ${userId} and created_at > now() - interval '1 minute'
  `);
  if ((rows[0] as { n: number }).n >= RATE_LIMIT_PER_MINUTE) throw new RateLimited();
}

const NO_SUCH_CAT = "There is no such cat.";

/**
 * The finder asks for another name. A free one from the list is set at once: no AI, no approval. Refused for
 * anyone else (403) and once a caretaker has approved or set a name (409), both decided under the lock.
 */
export async function anotherName(userId: string, catId: string): Promise<string> {
  await assertUnderNameLimit(userId);
  return withColonyLock(async (tx) => {
    const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
    if (!cat) throw new Refusal(404, NO_SUCH_CAT);
    if ((await finderOf(tx, catId)) !== userId) throw new Refusal(403, "Only the person who found this cat can do this.");
    if (cat.nameLocked) throw new Refusal(409, "A caretaker has chosen this name.");
    if (!anotherNameOpen(cat)) throw new Refusal(409, "This cat's name can no longer be changed.");
    const name = pickFreeName(await takenNames(tx));
    await tx.update(cats).set({ name }).where(eq(cats.id, catId));
    await tx.insert(agentActions).values({
      action: NAME_ANOTHER,
      inputs: { catId, userId, from: cat.name, to: name },
      reason: "A neighbour asked for another name for a cat.",
      status: "done",
    });
    return name;
  });
}

/** One person's idea of the real name. It replaces their earlier pending one for this cat and changes nothing public. */
export async function suggestName(userId: string, catId: string, raw: unknown): Promise<string> {
  const parsed = parseCatName(raw);
  if (!parsed.ok) throw new Refusal(400, parsed.message);
  await assertUnderNameLimit(userId);
  const [cat] = await db.select({ id: cats.id }).from(cats).where(eq(cats.id, catId));
  if (!cat) throw new Refusal(404, NO_SUCH_CAT);
  await db.transaction(async (tx) => {
    await tx
      .insert(nameSuggestions)
      .values({ catId, requesterId: userId, name: parsed.name })
      .onConflictDoUpdate({
        target: [nameSuggestions.catId, nameSuggestions.requesterId],
        targetWhere: sql`${nameSuggestions.status} = 'pending'`,
        set: { name: parsed.name, createdAt: sql`now()` },
      });
    await tx.insert(agentActions).values({
      action: NAME_SUGGESTED,
      inputs: { catId, userId },
      reason: "A neighbour suggested a name for a cat.",
      status: "done",
    });
  });
  return parsed.name;
}

export type NameControls = { canRename: boolean; /** This person's own pending suggestion. Nobody else's. */ pending: string | null };

/** What the cat card offers this person. */
export async function nameControls(catId: string, userId: string): Promise<NameControls> {
  const [cat] = await db.select({ id: cats.id, status: cats.status, nameLocked: cats.nameLocked }).from(cats).where(eq(cats.id, catId));
  if (!cat) return { canRename: false, pending: null };
  const [mine] = await db
    .select({ name: nameSuggestions.name })
    .from(nameSuggestions)
    .where(and(eq(nameSuggestions.catId, catId), eq(nameSuggestions.requesterId, userId), eq(nameSuggestions.status, "pending")))
    .orderBy(desc(nameSuggestions.createdAt))
    .limit(1);
  return { canRename: await canAskForAnotherName(db, cat, userId), pending: mine?.name ?? null };
}
