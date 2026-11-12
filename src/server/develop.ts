import { and, eq, sql } from "drizzle-orm";
import { parseCatBox } from "@/lib/keepsake";
import { db } from "./db/client";
import { cats, sightings } from "./db/schema";
import { findCat, type Found } from "./catFinder";
import { publishCatOnly, type KeepArea } from "./photos";
import { avatarFromPhoto } from "./photoAvatar";
import { PHONE_TIER_GRACE_SECONDS } from "./spot";
import { getStorage, removePublicCopy } from "./storage";

/*
 * The server tier of D11: the worker develops public photos the phone could not cut out, oldest first.
 * Every photo is published in the claim that looks at it: with the cat's cut-out, else a circle on its box,
 * else a circle in the middle. A model that fails or runs out of time falls to the next layer (R15).
 */

/** How long the model may look at one photo before the middle circle is used. */
export const DEVELOP_TIMEOUT_MS = 30_000;
/**
 * develop_attempts counts claims that did not publish (storage, publish or database failures, or a crash):
 * each claim adds one before any work, and a claim that publishes takes it back. After this many the photo
 * is published with no model, and past it the photo sorts behind the healthy ones so it cannot block the queue.
 */
export const DEVELOP_MAX_ATTEMPTS = 3;
/** Past this many failed claims the photo is logged loudly on each try: something needs a person. */
const LOUD_AFTER = DEVELOP_MAX_ATTEMPTS + 3;

const NO_CAT: KeepArea = { box: null, mask: null };

/** CAT_FINDER=off switches the model off at runtime: every queued photo is published with the soft circle. */
const finderOff = () => process.env.CAT_FINDER === "off";

type Claimed = { id: string; originalKey: string; catId: string | null; attempts: number; storedBox: unknown };

/**
 * Takes the next photo waiting to be developed and commits one more attempt on it before any work starts,
 * so a run that kills the worker still counts. Oldest first, except that a photo that has failed more than
 * DEVELOP_MAX_ATTEMPTS times waits behind every other. Rows the phone tier may still be publishing are left alone.
 */
async function claim(): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      select id from sightings
      where needs_develop and developed_at is null
        and created_at < now() - make_interval(secs => ${PHONE_TIER_GRACE_SECONDS})
      order by (develop_attempts > ${DEVELOP_MAX_ATTEMPTS}) asc, created_at asc, id asc
      for update skip locked
      limit 1
    `);
    const row = rows[0] as { id: string } | undefined;
    if (!row) return null;
    const [c] = await tx
      .update(sightings)
      .set({ developAttempts: sql`${sightings.developAttempts} + 1` })
      .where(eq(sightings.id, row.id))
      .returning({
        id: sightings.id,
        originalKey: sightings.originalKey,
        catId: sightings.catId,
        attempts: sightings.developAttempts,
        storedBox: sightings.catBox,
      });
    return c;
  });
}

/** What the model found. No cat when it fails or runs past DEVELOP_TIMEOUT_MS: the photo still publishes. */
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
  } catch (e) {
    // Model and runtime errors carry no storage keys, so the message is safe to log.
    console.error(`[develop] the cat finder failed; publishing with the middle circle: ${e instanceof Error ? e.message : typeof e}`);
    return NO_CAT;
  } finally {
    clearTimeout(timer);
  }
}

/** The keep area for a claim: the model's answer, or with the model off the phone's box (if any) as a circle. */
async function keepFor(s: Claimed, original: Buffer): Promise<KeepArea> {
  if (finderOff()) return { box: parseCatBox(s.storedBox), mask: null };
  // A photo that has failed this often may be the one crashing the worker, so the model is not run on it again.
  if (s.attempts > DEVELOP_MAX_ATTEMPTS) return NO_CAT;
  return look(original);
}

/**
 * Develops one photo: finds the cat, sets the cat's colours from the photo, publishes the cat-only copy and
 * marks the sighting developed. "idle" when nothing was developed: the queue is empty, or this claim failed
 * and the photo waits for a later tick.
 */
export async function developNext(): Promise<"developed" | "idle"> {
  const s = await claim();
  if (!s) return "idle";
  if (s.attempts > LOUD_AFTER) {
    console.error(`[develop] sighting ${s.id} has failed to publish ${s.attempts - 1} times; a person should check its original and storage`);
  }
  try {
    const original = await getStorage().getPrivate(s.originalKey);
    const keep = await keepFor(s, original);
    const avatar = await avatarFromPhoto(original, keep.box);
    const { key } = await publishCatOnly(s.originalKey, keep);
    const won = await db.transaction(async (tx) => {
      const marked = await tx
        .update(sightings)
        // This claim published, so it is not one of the failed attempts the column counts.
        .set({ publicKey: key, publicReady: true, developedAt: new Date(), developAttempts: sql`${sightings.developAttempts} - 1` })
        .where(and(eq(sightings.id, s.id), sql`${sightings.developedAt} is null`))
        .returning({ id: sightings.id });
      if (marked.length === 0) return false;
      if (s.catId) await tx.update(cats).set({ avatar }).where(eq(cats.id, s.catId));
      return true;
    });
    // Lost to the phone tier (or a caretaker's hold): this copy belongs to no sighting, so it is deleted.
    if (!won) {
      console.error("[develop] the photo was developed elsewhere first; this public copy is deleted");
      await removePublicCopy(key);
    }
    return "developed";
  } catch (e) {
    // Class name only: errors from storage can carry keys.
    console.error(`[develop] not developed, will try again: ${e instanceof Error ? e.name : typeof e}`);
    return "idle";
  }
}
