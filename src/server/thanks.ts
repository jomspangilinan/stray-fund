import { sql } from "drizzle-orm";
import { CAPTURED } from "./ledger";
import { db } from "./db/client";

/*
 * Thanks and badges. Everything here comes from verified actions in the database, never from what a person
 * says about themselves:
 *  - spotted: a sighting a person accepted or the AI matched (state matched or new_cat), and the first one for the cat
 *  - funded: a net positive allocation from that person's captured donation
 *  - vet care: a receipt that was verified, for the vet on the booking
 *  - caretaker: evidence accepted, or a cat marked adopted, recorded in the audit trail
 * Order is by when it happened. Amounts are never selected, so nothing can sort or show by them.
 * Only a username (or "A neighbour"), a short sentence and badge labels leave this file.
 */

const MAX_CAT_THANKS = 6;
const MAX_HOME_THANKS = 6;
const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export type BadgeKey = "first_spot" | "spots_5" | "spots_25" | "neutered" | "home";
export const BADGE_LABEL: Record<BadgeKey, string> = {
  first_spot: "First spot",
  spots_5: "5 spots",
  spots_25: "25 spots",
  neutered: "Helped a cat get neutered",
  home: "Helped a cat get home",
};

export type Thanks = { name: string; text: string; badges: string[] };

export function badgesOf(i: { spots: number; helpedNeutered: boolean; helpedHome: boolean }): BadgeKey[] {
  const out: BadgeKey[] = [];
  if (i.spots >= 1) out.push("first_spot");
  if (i.spots >= 5) out.push("spots_5");
  if (i.spots >= 25) out.push("spots_25");
  if (i.helpedNeutered) out.push("neutered");
  if (i.helpedHome) out.push("home");
  return out;
}

type Kind = "spotted_first" | "spotted" | "funded" | "vet_care" | "checked" | "adopted";
type Row = { user_id: string; cat_id: string; cat: string; kind: Kind; at: Date | string; username: string; show: boolean };

const CARD_TEXT: Record<Kind, string> = {
  spotted_first: "spotted first",
  spotted: "spotted",
  funded: "helped fund",
  vet_care: "gave vet care",
  checked: "checked vet care",
  adopted: "marked adopted",
};
const HOME_TEXT: Record<Kind, (cat: string) => string> = {
  spotted_first: (c) => `spotted ${c} first`,
  spotted: (c) => `spotted ${c}`,
  funded: (c) => `helped fund ${c}`,
  vet_care: (c) => `gave vet care to ${c}`,
  checked: (c) => `checked vet care for ${c}`,
  adopted: (c) => `marked ${c} adopted`,
};

/** One row per person, cat and kind, newest first. No amount is ever read. */
const events = sql`
  select e.user_id, e.cat_id, c.name as cat, e.kind, e.at, u.username, u.show_name_in_thanks as show
  from (
    select user_id, cat_id, kind, max(at) as at from (
      select s.caught_by_user_id as user_id, s.cat_id,
             case when row_number() over (partition by s.cat_id order by s.created_at, s.id) = 1
                  then 'spotted_first' else 'spotted' end as kind,
             s.created_at as at
      from sightings s
      where s.state in ('matched', 'new_cat') and s.caught_by_user_id is not null and s.cat_id is not null
      union all
      select d.user_id, a.cat_id, 'funded', max(a.created_at)
      from allocations a join donations d on d.id = a.donation_id
      where d.status = ${CAPTURED} and d.user_id is not null and a.cat_id is not null
      group by d.user_id, a.cat_id
      having sum(a.amount) > 0
      union all
      select b.vet_id, b.cat_id, 'vet_care', r.created_at
      from receipts r join bookings b on b.id = r.booking_id
      where r.verification = 'verified'
      union all
      select g.approved_by,
             (g.inputs->>'catId')::uuid,
             case g.action when 'evidence_accepted' then 'checked' else 'adopted' end,
             g.created_at
      from agent_actions g
      where g.approved_by is not null
        and g.inputs->>'catId' ~* ${UUID_RE}
        and (g.action = 'evidence_accepted' or (g.action = 'cat_updated' and g.inputs->>'change' = 'adopted'))
    ) raw
    group by user_id, cat_id, kind
  ) e
  join cats c on c.id = e.cat_id
  join users u on u.id = e.user_id
  -- Someone who spotted a cat first is not also listed for plain spotting of it.
  where not (e.kind = 'spotted' and exists (
    select 1 from sightings f where f.cat_id = e.cat_id and f.caught_by_user_id = e.user_id and f.state in ('matched','new_cat')
      and f.id = (select f2.id from sightings f2 where f2.cat_id = e.cat_id and f2.state in ('matched','new_cat') order by f2.created_at, f2.id limit 1)
  ))
`;

async function badgesFor(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const ids = sql.join(userIds.map((u) => sql`${u}::uuid`), sql`, `);
  const { rows } = await db.execute(sql`
    select u.id,
      (select count(*) from sightings s where s.caught_by_user_id = u.id and s.state in ('matched', 'new_cat'))::int as spots,
      exists (
        select 1 from (
          select a.cat_id from allocations a join donations d on d.id = a.donation_id
          where d.user_id = u.id and d.status = ${CAPTURED} and a.cat_id is not null
          group by a.cat_id having sum(a.amount) > 0
        ) f
        where exists (select 1 from treatments t where t.cat_id = f.cat_id and t.type = 'neuter')
      ) as neutered,
      exists (
        select 1 from (
          select a.cat_id from allocations a join donations d on d.id = a.donation_id
          where d.user_id = u.id and d.status = ${CAPTURED} and a.cat_id is not null
          group by a.cat_id having sum(a.amount) > 0
        ) f join cats c on c.id = f.cat_id
        where c.status = 'adopted' and exists (select 1 from treatments t where t.cat_id = f.cat_id and t.type = 'neuter')
      ) as home
    from users u where u.id in (${ids})
  `);
  for (const r of rows as { id: string; spots: number; neutered: boolean; home: boolean }[]) {
    out.set(
      r.id,
      badgesOf({ spots: r.spots, helpedNeutered: r.neutered, helpedHome: r.home }).map((k) => BADGE_LABEL[k]),
    );
  }
  return out;
}

const nameOf = (r: Row) => (r.show ? r.username : "A neighbour");

/** Up to six people who helped this cat, newest first. */
export async function getCatThanks(catId: string): Promise<Thanks[]> {
  const { rows } = await db.execute(sql`
    select * from (${events}) t where t.cat_id = ${catId}::uuid order by t.at desc, t.user_id, t.kind limit ${MAX_CAT_THANKS}
  `);
  const list = rows as Row[];
  const badges = await badgesFor([...new Set(list.map((r) => r.user_id))]);
  return list.map((r) => ({
    name: nameOf(r),
    text: CARD_TEXT[r.kind],
    badges: r.show ? (badges.get(r.user_id) ?? []) : [],
  }));
}

/** Recent helpers, each person once, by when they last helped. Never by how much or how often. */
export async function getHomeThanks(): Promise<Thanks[]> {
  const { rows } = await db.execute(sql`
    select * from (
      select distinct on (t.user_id) t.* from (${events}) t order by t.user_id, t.at desc, t.kind
    ) latest
    order by latest.at desc, latest.user_id
    limit ${MAX_HOME_THANKS}
  `);
  const list = rows as Row[];
  const badges = await badgesFor(list.map((r) => r.user_id));
  return list.map((r) => ({
    name: nameOf(r),
    text: HOME_TEXT[r.kind](r.cat),
    badges: r.show ? (badges.get(r.user_id) ?? []) : [],
  }));
}

/** A person's own badges, shown only to them, whether or not they appear by name in thanks. */
export async function getBadgesFor(userId: string): Promise<string[]> {
  return (await badgesFor([userId])).get(userId) ?? [];
}
