import { and, eq, isNull } from "drizzle-orm";
import { catAvatar } from "@/lib/avatar";
import { db } from "./db/client";
import { cats } from "./db/schema";

const BATCH = 50;

/**
 * Gives every cat without a look-alike one, from its stored coat. Pure rules, no AI call. A cat with no coat
 * on file gets the neutral cat. The update only touches rows still empty, so a run that overlaps another is harmless.
 */
export async function backfillAvatars(): Promise<number> {
  const rows = await db
    .select({ id: cats.id, coat: cats.coat, coatPattern: cats.coatPattern })
    .from(cats)
    .where(isNull(cats.avatar))
    .limit(BATCH);
  let n = 0;
  for (const r of rows) {
    const done = await db
      .update(cats)
      .set({ avatar: catAvatar(r.coat, r.coatPattern) })
      .where(and(eq(cats.id, r.id), isNull(cats.avatar)))
      .returning({ id: cats.id });
    n += done.length;
  }
  return n;
}
