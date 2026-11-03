import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { COLONY } from "@/lib/config";
import { NEUTRAL_AVATAR, parseAvatar } from "@/lib/avatar";
import { goalPercent } from "@/lib/goal";
import { careMarks, pickYard, yardStage, type YardCat, type YardGroup } from "@/lib/yard";
import { pickMissions, type Mission, type MissionCat } from "@/lib/missions";
import { hidePrivateInDemo } from "./demoPrivacy";
import { db } from "./db/client";
import { cats, earTipFlags, guardrails, nameSuggestions, sightings, treatments, users } from "./db/schema";
import { ownFlags } from "./earTipFlags";
import { CAPTURED, getPoolStatus, toInt } from "./ledger";
import { PRIVATE_ACTIONS } from "./privateActions";
import type { Session } from "./session";
import { getStorage } from "./storage";

/*
 * The privacy boundary. Every public page and route goes through the whitelists
 * in this file. Each function builds a new object field by field and never
 * spreads a database row, so a column added to a table later stays private until
 * someone adds it here on purpose.
 *
 * Never public: exact or fuzzed coordinates, original photo keys, sighting state,
 * assessments, emails, receipts, who caught a cat, agent inputs, approvers, gateway errors.
 */

const TZ = "Asia/Manila";
const MAX_CATS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** A calendar date in Asia/Manila as YYYY-MM-DD. Time of day is never exposed. */
export function manilaDate(d: Date): string {
  return dayFormat.format(d);
}

export const isUuid = (s: string) => UUID.test(s);

export const SEX_LABEL: Record<string, string> = { female: "Female", male: "Male", unknown: "Sex unknown" };

export const STATUS_LABEL: Record<string, string> = {
  spotted: "Spotted",
  queued: "Waiting for funding",
  funded: "Funded",
  booked: "Vet visit booked",
  in_care: "In care",
  neutered: "Neutered",
  adoptable: "Ready for a home",
  adopted: "Adopted",
};

/** What a cat that only neighbours called already neutered is called in public, until a caretaker confirms it. */
export const NEIGHBOURS_SAY_NEUTERED = "Neighbours say already neutered";

/** Only a cat still at "neutered" can be waiting on a caretaker; later statuses came through a caretaker or a vet. */
const unconfirmedNeutered = (c: { status: string; neuteredUnconfirmed: boolean }) =>
  c.status === "neutered" && c.neuteredUnconfirmed;

export const FLAG_LABEL: Record<string, string> = {
  pregnant: "Pregnant",
  injured: "Injured",
  sick: "Sick",
  kitten: "Kitten",
};

const TREATMENT_LABEL: Record<string, string> = {
  neuter: "Neuter",
  vaccine: "Vaccine",
  deworming: "Deworming",
};

export const STATUS_GROUPS = {
  waiting: ["spotted", "queued", "funded", "booked"],
  "in-care": ["in_care"],
  neutered: ["neutered"],
  home: ["adoptable"],
} as const;
export type StatusGroup = keyof typeof STATUS_GROUPS;
export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  waiting: "Waiting",
  "in-care": "In care",
  neutered: "Neutered",
  home: "Ready for a home",
};
const isGroup = (g: string): g is StatusGroup => Object.hasOwn(STATUS_GROUPS, g);

// ---------- Types ----------

type CatPublicColumns = Pick<
  typeof cats.$inferSelect,
  "id" | "name" | "sex" | "status" | "flags" | "areaName" | "bio" | "earTipped" | "neuteredUnconfirmed" | "createdAt"
>;
type CatFull = CatPublicColumns &
  Pick<typeof cats.$inferSelect, "exactLat" | "exactLng" | "locationApproximate">;

export type TreatmentInput = {
  id: string;
  type: string;
  product: string | null;
  date: string;
  nextDue: string | null;
  vet: string | null;
};

export type CatContext = {
  photoKey: string | null;
  sightingCount: number;
  treatments: TreatmentInput[];
  firstSeenAt?: Date | null;
};

export type JourneyStep = { step: string; done: boolean; date?: string; note?: string };

export type PublicCat = {
  id: string;
  name: string;
  sex: string;
  status: string;
  statusLabel: string;
  area: string;
  bio: string | null;
  earTipped: boolean | null;
  flags: string[];
  journey: JourneyStep[];
  photoUrl: string | null;
  sightingCount: number;
};

export type PublicSighting = { id: string; date: string; photoUrl: string | null };

export type PublicTreatment = {
  id: string;
  type: string;
  product: string | null;
  date: string;
  nextDue: string | null;
  overdue: boolean;
  vet: string | null;
};

export type PublicLedgerRow = {
  date: string;
  type: string;
  amount: number;
  fee: number | null;
  cat: string | null;
  catId: string | null;
  reason: string | null;
  paypalId: string | null;
  status: string;
  who: string | null;
};

export type ExactLocation = { lat: number; lng: number; approximate: boolean };
export type CatForViewer = PublicCat & { exact?: ExactLocation };

// ---------- Journey ----------

type JourneyCat = { status: string; earTipped: boolean | null; neuteredUnconfirmed?: boolean; firstSeenAt?: Date | null };

const NEUTERED_STATUSES = ["neutered", "adoptable", "adopted"];

function latest(dates: string[]): string | undefined {
  return dates.length ? [...dates].sort().at(-1) : undefined;
}

function step(name: string, done: boolean, date?: string, note?: string): JourneyStep {
  const s: JourneyStep = { step: name, done };
  if (done && date) s.date = date;
  if (note) s.note = note;
  return s;
}

export function journey(cat: JourneyCat, rows: Pick<TreatmentInput, "type" | "date">[]): JourneyStep[] {
  const datesOf = (type: string) => rows.filter((t) => t.type === type).map((t) => t.date);
  const neuterDate = datesOf("neuter").sort()[0];
  // Two neighbours agreeing moves a cat, but the card does not tick Neutered until a caretaker or a vet says so.
  const said = !neuterDate && unconfirmedNeutered({ status: cat.status, neuteredUnconfirmed: cat.neuteredUnconfirmed === true });
  const alreadyNeutered = !neuterDate && !said && cat.earTipped === true;
  const neutered = !said && (Boolean(neuterDate) || alreadyNeutered || NEUTERED_STATUSES.includes(cat.status));
  const vaccinated = latest(datesOf("vaccine"));
  const dewormed = latest(datesOf("deworming"));
  return [
    step("Spotted", true, cat.firstSeenAt ? manilaDate(cat.firstSeenAt) : undefined),
    step("Neutered", neutered, neuterDate, said ? NEIGHBOURS_SAY_NEUTERED : alreadyNeutered ? "Already neutered when found" : undefined),
    step("Vaccinated", Boolean(vaccinated), vaccinated),
    step("Dewormed", Boolean(dewormed), dewormed),
    step("Adoptable", cat.status === "adoptable" || cat.status === "adopted"),
    step("Adopted", cat.status === "adopted"),
  ];
}

// ---------- Whitelist serializers ----------

const photoUrl = (key: string | null) => (key ? getStorage().publicUrl(key) : null);

export function publicCat(row: CatPublicColumns, ctx: CatContext): PublicCat {
  return {
    id: row.id,
    name: row.name,
    sex: SEX_LABEL[row.sex] ?? SEX_LABEL.unknown,
    status: row.status,
    statusLabel: unconfirmedNeutered(row) ? NEIGHBOURS_SAY_NEUTERED : (STATUS_LABEL[row.status] ?? row.status),
    area: row.areaName,
    bio: row.bio ?? null,
    earTipped: row.earTipped ?? null,
    flags: (row.flags ?? []).map((f) => FLAG_LABEL[f]).filter((f): f is string => Boolean(f)),
    journey: journey(
      { status: row.status, earTipped: row.earTipped ?? null, neuteredUnconfirmed: row.neuteredUnconfirmed, firstSeenAt: ctx.firstSeenAt ?? row.createdAt },
      ctx.treatments,
    ),
    photoUrl: photoUrl(ctx.photoKey),
    sightingCount: ctx.sightingCount,
  };
}

type SightingInput = {
  id: string;
  takenAt: Date | null;
  createdAt: Date;
  publicKey: string | null;
  publicReady: boolean;
};

export function publicSighting(row: SightingInput): PublicSighting {
  return {
    id: row.id,
    date: manilaDate(row.takenAt ?? row.createdAt),
    photoUrl: row.publicReady ? photoUrl(row.publicKey) : null,
  };
}

export function publicTreatment(row: TreatmentInput, today: string = manilaDate(new Date())): PublicTreatment {
  return {
    id: row.id,
    type: TREATMENT_LABEL[row.type] ?? row.type,
    product: row.product ?? null,
    date: row.date,
    nextDue: row.nextDue ?? null,
    overdue: row.nextDue != null && row.nextDue < today,
    vet: row.vet ?? null,
  };
}

type LedgerInput = {
  date: Date | string;
  type: string;
  amount: number;
  fee: number | null;
  cat: string | null;
  catId: string | null;
  reason: string | null;
  paypalId: string | null;
  status: string;
  who: string | null;
};

/** Mapper only. The ledger query lives with the impact page. `who` is a username, never an email. */
export function publicLedgerRow(row: LedgerInput): PublicLedgerRow {
  return {
    date: typeof row.date === "string" ? row.date : manilaDate(row.date),
    type: row.type,
    amount: row.amount,
    fee: row.fee ?? null,
    cat: row.cat ?? null,
    catId: row.catId ?? null,
    reason: row.reason ?? null,
    paypalId: row.paypalId ?? null,
    status: row.status,
    who: row.who ?? null,
  };
}

const ACTION_LABEL: Record<string, string> = {
  fund_cat: "Funded a cat",
  payout_deposit: "Vet first payment",
  payout_balance: "Vet final payment",
  caretaker_review: "Asked a caretaker",
  payout_review_resolved: "Caretaker settled a payment",
  payout_note: "Caretaker added a note to a payment",
  payout_retry_allowed: "Caretaker allowed one more try at a payment",
  guardrails_changed: "Caretaker changed a spending rule",
  payee_added: "Caretaker allowed a vet to be paid",
  payee_removed: "Caretaker stopped payments to a vet",
  vet_details_changed: "Caretaker updated a vet's details",
  evidence_accepted: "Caretaker accepted a vet's receipt",
  evidence_rejected: "Caretaker did not accept a vet's receipt",
  ear_tip_confirmed: "Caretaker confirmed the ear-tip in a vet's photo",
  sighting_reviewed: "Caretaker settled a sighting",
  cat_updated: "Caretaker updated a cat's card",
  photo_published: "Caretaker published a photo",
  photo_held: "Caretaker held back a photo",
};

const ACTION_STATUS_LABEL: Record<string, string> = {
  done: "Done",
  open: "Waiting for a caretaker",
  awaiting_approval: "Waiting for approval",
  queued: "Sending",
  sent: "Sent",
  succeeded: "Paid",
  failed: "Failed",
  needs_review: "Being checked",
  rejected: "Rejected",
  resolved: "Settled by a caretaker",
  denied: "Refused by the rules",
};

export type PublicAgentAction = {
  id: string;
  action: string;
  reason: string;
  amount: number | null;
  status: string;
  /** Whether the action was held back or went wrong, for styling only. */
  refused: boolean;
  /** Only whether a person signed it off. Never who. */
  signedOffByPerson: boolean;
  paypalRef: string | null;
  date: string;
  cat: string | null;
};

type AgentActionInput = {
  id: string;
  action: string;
  reason: string;
  amount: number | null;
  status: string;
  paypalRef: string | null;
  createdAt: Date;
  cat: string | null;
  signedOffByPerson: boolean;
};

/**
 * True only for a vet payment a caretaker approved and the rules then let go ahead. A refusal or rejection also
 * stamps a caretaker on the row, and a note, review or rule change on a payment is not an approval, so none of those count.
 * A bare yes or no: it never says who.
 */
function personApprovedPayout(row: Pick<AgentActionInput, "action" | "status" | "signedOffByPerson">): boolean {
  return (
    row.signedOffByPerson === true &&
    (row.action === "payout_deposit" || row.action === "payout_balance") &&
    !["rejected", "denied", "awaiting_approval"].includes(row.status)
  );
}

/** Never inputs, approver identities or gateway error text, which all live on the same row. */
export function publicAgentAction(row: AgentActionInput): PublicAgentAction {
  return {
    id: row.id,
    action: ACTION_LABEL[row.action] ?? "Treasurer action",
    reason: row.reason,
    amount: row.amount ?? null,
    status: ACTION_STATUS_LABEL[row.status] ?? "Recorded",
    refused: ["denied", "failed", "rejected"].includes(row.status),
    signedOffByPerson: personApprovedPayout(row),
    paypalRef: row.paypalRef ?? null,
    date: manilaDate(row.createdAt),
    cat: row.cat ?? null,
  };
}

const MAX_AGENT_ACTIONS = 100;

/** Newest first. The cat comes from the action's payout, or for funding from its recorded id. */
export async function listAgentActions(limit: number = MAX_AGENT_ACTIONS): Promise<PublicAgentAction[]> {
  const { rows } = await db.execute(sql`
    select a.id, a.action, a.reason, a.amount, a.status, a.paypal_ref, a.created_at, c.name as cat,
           (a.approved_by is not null) as approved_by_person
    from agent_actions a
    left join payouts p on p.action_id = a.id
    left join cats c on c.id = coalesce(
      p.cat_id,
      case when a.inputs->>'catId' ~* ${UUID.source} then (a.inputs->>'catId')::uuid end
    )
    -- Private actions (a neighbour's ear-tip answer, anything about a cat's name) leave an audit row, never a feed row.
    where a.action not in (${sql.join(PRIVATE_ACTIONS.map((a) => sql`${a}`), sql`, `)})
    order by a.created_at desc, a.id desc
    limit ${Math.min(Math.max(1, Math.trunc(limit)), MAX_AGENT_ACTIONS)}
  `);
  return (rows as {
    id: string;
    action: string;
    reason: string;
    amount: number | null;
    status: string;
    paypal_ref: string | null;
    created_at: Date | string;
    cat: string | null;
    approved_by_person: boolean;
  }[]).map((r) =>
    publicAgentAction({
      id: r.id,
      action: r.action,
      reason: r.reason,
      amount: r.amount,
      status: r.status,
      paypalRef: r.paypal_ref,
      createdAt: new Date(r.created_at),
      cat: r.cat,
      signedOffByPerson: r.approved_by_person === true,
    }),
  );
}

/** Exact coordinates only for caretakers and vets. Fuzzed ones are never exposed. */
export function catForViewer(row: CatFull, session: Session | null, ctx: CatContext): CatForViewer {
  const out: CatForViewer = publicCat(row, ctx);
  const trusted = session?.role === "caretaker" || session?.role === "vet";
  if (trusted && !hidePrivateInDemo() && row.exactLat != null && row.exactLng != null) {
    out.exact = { lat: row.exactLat, lng: row.exactLng, approximate: row.locationApproximate };
  }
  return out;
}

// ---------- Queries ----------

const publicCatColumns = {
  id: cats.id,
  name: cats.name,
  sex: cats.sex,
  status: cats.status,
  flags: cats.flags,
  areaName: cats.areaName,
  bio: cats.bio,
  earTipped: cats.earTipped,
  neuteredUnconfirmed: cats.neuteredUnconfirmed,
  createdAt: cats.createdAt,
};

type SightingRow = SightingInput & { catId: string | null };

async function loadSightings(catIds: string[]): Promise<SightingRow[]> {
  if (catIds.length === 0) return [];
  return db
    .select({
      id: sightings.id,
      catId: sightings.catId,
      takenAt: sightings.takenAt,
      createdAt: sightings.createdAt,
      publicKey: sightings.publicKey,
      publicReady: sightings.publicReady,
    })
    .from(sightings)
    .where(and(inArray(sightings.catId, catIds), inArray(sightings.state, ["matched", "new_cat"])))
    .orderBy(asc(sightings.createdAt), asc(sightings.id));
}

async function loadTreatments(catIds: string[]): Promise<(TreatmentInput & { catId: string })[]> {
  if (catIds.length === 0) return [];
  return db
    .select({
      id: treatments.id,
      catId: treatments.catId,
      type: treatments.type,
      product: treatments.product,
      date: treatments.date,
      nextDue: treatments.nextDue,
      vet: users.username,
    })
    .from(treatments)
    .leftJoin(users, eq(users.id, treatments.vetId))
    .where(inArray(treatments.catId, catIds))
    .orderBy(asc(treatments.date), asc(treatments.id));
}

function contextFor(
  catId: string,
  sights: SightingRow[],
  treats: (TreatmentInput & { catId: string })[],
): CatContext {
  const mine = sights.filter((s) => s.catId === catId);
  const photo = [...mine].reverse().find((s) => s.publicReady && s.publicKey);
  const first = mine[0];
  return {
    photoKey: photo?.publicKey ?? null,
    sightingCount: mine.length,
    firstSeenAt: first ? (first.takenAt ?? first.createdAt) : null,
    treatments: treats.filter((t) => t.catId === catId),
  };
}

async function hydrate(rows: CatPublicColumns[]): Promise<PublicCat[]> {
  const ids = rows.map((r) => r.id);
  const [sights, treats] = await Promise.all([loadSightings(ids), loadTreatments(ids)]);
  return rows.map((r) => publicCat(r, contextFor(r.id, sights, treats)));
}

/**
 * A cat that neighbours called already neutered waits with the Waiting cats until a caretaker confirms it, so the
 * Neutered list holds only cats a caretaker or a vet has settled.
 */
function groupWhere(group: StatusGroup) {
  const inGroup = inArray(cats.status, [...STATUS_GROUPS[group]]);
  if (group === "neutered") return and(inGroup, eq(cats.neuteredUnconfirmed, false));
  if (group === "waiting") return or(inGroup, and(eq(cats.status, "neutered"), eq(cats.neuteredUnconfirmed, true)));
  return inGroup;
}

/** Newest first, capped. Unknown group names mean all cats. */
export async function listCats(group: string = "all"): Promise<PublicCat[]> {
  const where = isGroup(group) ? groupWhere(group) : undefined;
  const rows = await db
    .select(publicCatColumns)
    .from(cats)
    .where(where)
    .orderBy(desc(cats.createdAt), asc(cats.id))
    .limit(MAX_CATS);
  return hydrate(rows);
}

export type CatCardData = { cat: PublicCat; sightings: PublicSighting[]; health: PublicTreatment[] };

export async function getCatCard(id: string): Promise<CatCardData | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select(publicCatColumns).from(cats).where(eq(cats.id, id));
  if (!row) return null;
  const [sights, treats] = await Promise.all([loadSightings([id]), loadTreatments([id])]);
  const today = manilaDate(new Date());
  return {
    cat: publicCat(row, contextFor(id, sights, treats)),
    sightings: [...sights].reverse().map(publicSighting),
    health: treats.map((t) => publicTreatment(t, today)),
  };
}

/** The API shape: the public card plus exact location for caretakers and vets only. */
export async function getCatForViewer(id: string, session: Session | null): Promise<CatForViewer | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select({
      ...publicCatColumns,
      exactLat: cats.exactLat,
      exactLng: cats.exactLng,
      locationApproximate: cats.locationApproximate,
    })
    .from(cats)
    .where(eq(cats.id, id));
  if (!row) return null;
  const [sights, treats] = await Promise.all([loadSightings([id]), loadTreatments([id])]);
  return catForViewer(row, session, contextFor(id, sights, treats));
}

export type HelpedEntry = { cat: PublicCat; amount: number };

/** Net positive allocations from this user's captured donations, per cat, summed in SQL. */
export async function getHelpedEntries(userId: string): Promise<HelpedEntry[]> {
  const res = await db.execute(sql`
    select a.cat_id, sum(a.amount)::bigint as amount
    from allocations a
    join donations d on d.id = a.donation_id
    join cats c on c.id = a.cat_id
    where d.user_id = ${userId} and d.status = ${CAPTURED} and a.cat_id is not null
    group by a.cat_id, c.created_at
    having sum(a.amount) > 0
    order by sum(a.amount) desc, c.created_at desc, a.cat_id
  `);
  const found = (res.rows as { cat_id: string; amount: unknown }[]).map((r) => ({
    catId: r.cat_id,
    amount: toInt(r.amount),
  }));
  if (found.length === 0) return [];
  const rows = await db
    .select(publicCatColumns)
    .from(cats)
    .where(inArray(cats.id, found.map((f) => f.catId)));
  const byId = new Map((await hydrate(rows)).map((c) => [c.id, c]));
  return found.flatMap((f) => {
    const cat = byId.get(f.catId);
    return cat ? [{ cat, amount: f.amount }] : [];
  });
}

/** A cat this person helped, and how: they spotted it, a name of theirs was approved, or they gave to it. */
export type MyCat = { cat: PublicCat; spotted: boolean; named: boolean; amount: number };

/**
 * Every cat this person helped, once each. Reads only their own sightings, approved names and gifts, so it says
 * nothing about anyone else. A sighting counts once a cat is on it, whether it matched or started the card.
 */
export async function getHelpedCats(userId: string): Promise<MyCat[]> {
  const [gave, spottedRows, namedRows] = await Promise.all([
    getHelpedEntries(userId),
    db
      .selectDistinct({ catId: sightings.catId })
      .from(sightings)
      .where(and(eq(sightings.caughtByUserId, userId), inArray(sightings.state, ["matched", "new_cat"]))),
    db
      .selectDistinct({ catId: nameSuggestions.catId })
      .from(nameSuggestions)
      .where(and(eq(nameSuggestions.requesterId, userId), eq(nameSuggestions.status, "approved"))),
  ]);
  const spotted = new Set(spottedRows.flatMap((r) => (r.catId ? [r.catId] : [])));
  const named = new Set(namedRows.map((r) => r.catId));
  const byId = new Map<string, MyCat>(gave.map((e) => [e.cat.id, { cat: e.cat, spotted: false, named: false, amount: e.amount }]));
  const otherIds = [...new Set([...spotted, ...named])].filter((id) => !byId.has(id));
  if (otherIds.length > 0) {
    const rows = await db
      .select(publicCatColumns)
      .from(cats)
      .where(inArray(cats.id, otherIds))
      .orderBy(desc(cats.createdAt), asc(cats.id));
    for (const cat of await hydrate(rows)) byId.set(cat.id, { cat, spotted: false, named: false, amount: 0 });
  }
  for (const [id, e] of byId) {
    e.spotted = spotted.has(id);
    e.named = named.has(id);
  }
  // Gifts first, biggest first, equal gifts newest cat first; then the cats they spotted or named, newest cat first.
  // The sort is stable, so the order above decides every tie.
  return [...byId.values()].sort((x, y) => y.amount - x.amount);
}

export async function getHelped(userId: string): Promise<PublicCat[]> {
  return (await getHelpedEntries(userId)).map((e) => e.cat);
}

/** Captured net from this user's donations that no cat holds yet. */
export async function getUnallocated(userId: string): Promise<number> {
  const res = await db.execute(sql`
    select coalesce(sum(d.net - coalesce(x.allocated, 0)
             + (select coalesce(sum(r.net_delta), 0) from donation_reversals r where r.donation_id = d.id)), 0)::bigint as unallocated
    from donations d
    left join (
      select donation_id, sum(amount) as allocated from allocations group by donation_id
    ) x on x.donation_id = d.id
    where d.user_id = ${userId} and d.status = ${CAPTURED}
  `);
  const n = toInt((res.rows[0] as { unallocated: unknown }).unallocated);
  return Math.max(0, n);
}

/**
 * What the home screen shows. The only pool figure is what is free to fund the next cat, and the only
 * agent text is the newest public action. Nothing here carries a location, an email or an agent input.
 */
export type HomeData = {
  /** Centavos free in the pool, never negative. */
  poolAvailable: number;
  /** Centavos one care package costs, from the spending rules. */
  packagePrice: number;
  latestAction: PublicAgentAction | null;
  /** The newest cats first, capped. */
  cats: PublicCat[];
  /** How many cats the list holds, which may exceed the cats shown on a short list. */
  catCount: number;
};

const HOME_CATS = 5;
/** The same number as the guardrails column default, for a home page whose rules row is missing. */
const DEFAULT_PACKAGE_PRICE = 150_000;

export async function getHomeData(): Promise<HomeData> {
  const [pool, rules, actions, all] = await Promise.all([
    db.transaction((tx) => getPoolStatus(tx)),
    db.select({ packagePrice: guardrails.packagePrice }).from(guardrails).where(eq(guardrails.id, 1)),
    listAgentActions(1),
    listCats("all"),
  ]);
  return {
    poolAvailable: Math.max(0, pool.available),
    // The migration inserts this row. If it is ever missing, the home page still opens with the schema default.
    packagePrice: rules[0]?.packagePrice ?? DEFAULT_PACKAGE_PRICE,
    latestAction: actions[0] ?? null,
    cats: all.slice(0, HOME_CATS),
    catCount: all.length,
  };
}

export type GoalProgress = { neutered: number; goal: number; area: string; percent: number };

/**
 * The one neutered count for the Home goal, the yard and the Impact page: a cat with a neuter treatment, or a cat found
 * ear-tipped that a caretaker has confirmed (neighbours' word alone is not enough). One per cat, whatever its status.
 */
export const NEUTERED_CATS_SQL = sql`(
  select count(*) from cats c
  where exists (select 1 from treatments t where t.cat_id = c.id and t.type = 'neuter')
     or (c.ear_tipped = true and not c.neutered_unconfirmed)
)`;

/** The goal is a placeholder in config. Counts as NEUTERED_CATS_SQL does. */
export async function getGoalProgress(): Promise<GoalProgress> {
  const { rows } = await db.execute(sql`select ${NEUTERED_CATS_SQL}::int as n`);
  const neutered = toInt((rows[0] as { n: unknown }).n);
  return {
    neutered,
    goal: COLONY.goalCats,
    area: COLONY.area_name,
    percent: goalPercent(neutered, COLONY.goalCats),
  };
}

/** Missions from public-safe data only: public columns, public flag labels, and the scrubbed photo when ready. */
export async function getMissions(now: Date = new Date(), viewerId: string | null = null): Promise<Mission[]> {
  const rows = await db
    .select(publicCatColumns)
    .from(cats)
    .where(inArray(cats.status, [...STATUS_GROUPS.waiting, "adoptable"]))
    .orderBy(desc(cats.createdAt), asc(cats.id))
    .limit(MAX_CATS);
  const ids = rows.map((r) => r.id);
  const sights = await loadSightings(ids);
  // Counts of answers and the viewer's own answer. Never who said what.
  const flagRows = ids.length
    ? await db
        .select({ catId: earTipFlags.catId, value: earTipFlags.value, n: sql<number>`count(*)::int` })
        .from(earTipFlags)
        .where(inArray(earTipFlags.catId, ids))
        .groupBy(earTipFlags.catId, earTipFlags.value)
    : [];
  const answered = viewerId ? await ownFlags(db, viewerId, ids) : new Map();
  const input: MissionCat[] = rows.map((r) => {
    const mine = sights.filter((s) => s.catId === r.id);
    const last = mine.at(-1);
    const photo = [...mine].reverse().find((s) => s.publicReady && s.publicKey);
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      flags: (r.flags ?? []).map((f) => FLAG_LABEL[f]).filter((f): f is string => Boolean(f)),
      earTipped: r.earTipped ?? null,
      earTipYes: flagRows.find((f) => f.catId === r.id && f.value === "yes")?.n ?? 0,
      earTipNo: flagRows.find((f) => f.catId === r.id && f.value === "no")?.n ?? 0,
      answeredByMe: answered.has(r.id),
      photoUrl: photoUrl(photo?.publicKey ?? null),
      lastSeenAt: last ? (last.takenAt ?? last.createdAt) : r.createdAt,
    };
  });
  return pickMissions(input, now);
}

// ---------- The yard ----------

const YARD_GROUP_OF = (status: string, unconfirmed: boolean): YardGroup => {
  if (status === "adopted") return "adopted";
  if (unconfirmedNeutered({ status, neuteredUnconfirmed: unconfirmed })) return "waiting";
  for (const g of Object.keys(STATUS_GROUPS) as StatusGroup[]) {
    if ((STATUS_GROUPS[g] as readonly string[]).includes(status)) return g;
  }
  return "waiting";
};

export type PublicYard = {
  /** The cats to draw, in priority order. */
  cats: YardCat[];
  /** All cats, which may exceed the cats drawn. */
  total: number;
  stage: 0 | 1 | 2 | 3;
  goal: GoalProgress;
};

/**
 * What the yard may know: name, status group, look-alike and care marks. Built field by field. The look-alike
 * is read through parseAvatar, so only fixed palette names can reach the drawing. Nothing about where a cat is.
 */
export async function getYard(viewerId: string | null): Promise<PublicYard> {
  const [rows, goal, helped] = await Promise.all([
    db
      .select({ ...publicCatColumns, avatar: cats.avatar })
      .from(cats)
      .orderBy(desc(cats.createdAt), asc(cats.id))
      .limit(MAX_CATS),
    getGoalProgress(),
    viewerId ? getHelpedEntries(viewerId) : Promise.resolve([] as HelpedEntry[]),
  ]);
  const treats = await loadTreatments(rows.map((r) => r.id));
  const all: YardCat[] = rows.map((r) => {
    const pub = publicCat(r, contextFor(r.id, [], treats));
    return {
      id: r.id,
      name: r.name,
      group: YARD_GROUP_OF(r.status, r.neuteredUnconfirmed),
      statusLabel: pub.statusLabel,
      avatar: parseAvatar(r.avatar) ?? NEUTRAL_AVATAR,
      marks: careMarks(pub.journey),
      female: r.sex === "female",
    };
  });
  return {
    cats: pickYard(all, new Set(helped.map((h) => h.cat.id))),
    total: all.length,
    stage: yardStage(goal.neutered, goal.goal),
    goal,
  };
}
