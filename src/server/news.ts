import { sql } from "drizzle-orm";
import { db } from "./db/client";
import { getHelpedEntries, manilaDate } from "./public";

/*
 * News about the cats a person helped, since they last looked. Only true events from existing tables:
 * a treatment on record, or an accepted sighting by someone else. Each item is a sentence, a cat id and a
 * calendar date. No place, no time of day, no photo key.
 */

export type NewsItem = { catId: string; text: string; date: string };
export type News = { items: NewsItem[]; /** ISO time of the newest item, to confirm once it was seen. */ upTo: string | null };

const MAX_NEWS = 5;
const TREATMENT_TEXT: Record<string, string> = {
  neuter: "was neutered",
  vaccine: "was vaccinated",
  deworming: "was dewormed",
};

export async function getNews(userId: string): Promise<News> {
  const helped = await getHelpedEntries(userId);
  if (helped.length === 0) return { items: [], upTo: null };
  const names = new Map(helped.map((h) => [h.cat.id, h.cat.name]));
  const ids = sql.join(
    helped.map((h) => sql`${h.cat.id}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute(sql`
    with me as (select coalesce(news_seen_at, created_at) as since from users where id = ${userId})
    select * from (
      select t.cat_id, 'treatment:' || t.type as kind, t.created_at as at
      from treatments t, me where t.cat_id in (${ids}) and t.created_at > me.since
      union all
      select s.cat_id, 'sighting', s.created_at
      from sightings s, me
      where s.cat_id in (${ids}) and s.created_at > me.since
        and s.state in ('matched', 'new_cat')
        and s.caught_by_user_id is distinct from ${userId}::uuid
    ) e
    order by e.at desc, e.cat_id
    limit ${MAX_NEWS}
  `);
  const events = rows as { cat_id: string; kind: string; at: Date | string }[];
  const items: NewsItem[] = events.flatMap((e) => {
    const name = names.get(e.cat_id);
    if (!name) return [];
    const verb = e.kind === "sighting" ? "was seen again" : TREATMENT_TEXT[e.kind.slice("treatment:".length)];
    if (!verb) return [];
    return [{ catId: e.cat_id, text: `${name} ${verb}`, date: manilaDate(new Date(e.at)) }];
  });
  // Postgres keeps microseconds and a JS date keeps milliseconds, so round up one millisecond to clear the item.
  const newest = events[0] ? new Date(new Date(events[0].at).getTime() + 1).toISOString() : null;
  return { items, upTo: items.length ? newest : null };
}

/** Moves the marker forward to what the person saw. Never backward, never into the future. */
export async function markNewsSeen(userId: string, upTo: string): Promise<void> {
  const t = new Date(upTo);
  if (Number.isNaN(t.getTime())) return;
  await db.execute(sql`
    update users
    set news_seen_at = greatest(coalesce(news_seen_at, '-infinity'::timestamptz), least(now(), ${t.toISOString()}::timestamptz))
    where id = ${userId}
  `);
}

