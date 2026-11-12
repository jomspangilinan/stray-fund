import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { cats, sightings } from "./db/schema";
import { findCat, type Found } from "./catFinder";
import { publishCatOnly, type KeepArea } from "./photos";
import { avatarFromPhoto } from "./photoAvatar";
import { PHONE_TIER_GRACE_SECONDS } from "./spot";
import { getStorage } from "./storage";

/*
 * The server tier of D11: the worker develops public photos the phone could not cut out, one at a time,
 * oldest first. Every photo is published in the end: with the cat's cut-out, else a circle on its box,
 * else a circle in the middle.
 */

/** How long the model may look at one photo before the middle circle is used. */
export const DEVELOP_TIMEOUT_MS = 30_000;
/** A photo whose develops failed (or crashed the worker) this many times is published with no model. */
export const DEVELOP_MAX_ATTEMPTS = 3;

const NO_CAT: KeepArea = { box: null, mask: null };

type Claimed = { id: string; originalKey: string; catId: string | null; useModel: boolean };

/**
 * Takes the oldest photo waiting to be developed and commits one more attempt on it before any work starts,
 * so a run that kills the worker still counts. Rows the phone tier may still be publishing are left alone.
 */
async function claim(): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      select id, original_key, cat_id, develop_attempts from sightings
      where needs_develop and developed_at is null
        and created_at < now() - make_interval(secs => ${PHONE_TIER_GRACE_SECONDS})
      order by created_at asc, id asc
      for update skip locked
      limit 1
    `);
    const row = rows[0] as { id: string; original_key: string; cat_id: string | null; develop_attempts: number } | undefined;
    if (!row) return null;
    const useModel = row.develop_attempts < DEVELOP_MAX_ATTEMPTS;
    if (useModel) {
      await tx
        .update(sightings)
        .set({ developAttempts: sql`${sightings.developAttempts} + 1` })
        .where(eq(sightings.id, row.id));
    }
    return { id: row.id, originalKey: row.original_key, catId: row.cat_id, useModel };
  });
}

/** What the model found, or no cat when it runs past DEVELOP_TIMEOUT_MS. A thrown error is passed on. */
async function look(jpeg: Buffer): Promise<KeepArea> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      stop.abort(new Error("develop timed out"));
      resolve(null);
    }, DEVELOP_TIMEOUT_MS);
  });
  try {
    const found: Found | null = await Promise.race([findCat(jpeg, stop.signal), timedOut]);
    if (!found) console.error("[develop] the cat finder ran out of time; publishing with the middle circle");
    return found ?? NO_CAT;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Develops one photo: finds the cat, publishes the cat-only copy, sets the cat's colours from the photo
 * and marks the sighting developed. "idle" when nothing was developed: the queue is empty, or this
 * attempt failed and the photo waits for the next tick.
 */
export async function developNext(): Promise<"developed" | "idle"> {
  const s = await claim();
  if (!s) return "idle";
  try {
    const original = await getStorage().getPrivate(s.originalKey);
    const keep = s.useModel ? await look(original) : NO_CAT;
    const { key } = await publishCatOnly(s.originalKey, keep);
    const avatar = await avatarFromPhoto(original, keep.box);
    const won = await db.transaction(async (tx) => {
      const marked = await tx
        .update(sightings)
        .set({ publicKey: key, publicReady: true, developedAt: new Date() })
        .where(and(eq(sightings.id, s.id), sql`${sightings.developedAt} is null`))
        .returning({ id: sightings.id });
      if (marked.length === 0) return false;
      if (s.catId) await tx.update(cats).set({ avatar }).where(eq(cats.id, s.catId));
      return true;
    });
    // Lost to the phone tier: its copy stands and this one is left in place. Task 8 adds the delete.
    if (!won) console.error("[develop] the photo was developed elsewhere first; this public copy is left in place");
    return "developed";
  } catch (e) {
    // Class name only: errors from storage can carry keys.
    console.error(`[develop] not developed, will try again: ${e instanceof Error ? e.name : typeof e}`);
    return "idle";
  }
}
