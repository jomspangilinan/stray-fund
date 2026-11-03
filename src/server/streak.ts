import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/client";
import { sightings } from "./db/schema";
import { streakOf, type Streak } from "@/lib/streak";

/** When this person's accepted sightings happened. Rejected, pending and unresolved ones are not here. */
export async function getStreakDates(userId: string): Promise<Date[]> {
  const rows = await db
    .select({ at: sightings.createdAt })
    .from(sightings)
    .where(and(eq(sightings.caughtByUserId, userId), inArray(sightings.state, ["matched", "new_cat"])));
  return rows.map((r) => r.at);
}

export async function getStreak(userId: string, now: Date = new Date()): Promise<Streak> {
  return streakOf(await getStreakDates(userId), now);
}
