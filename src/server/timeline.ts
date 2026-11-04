import { asc, eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { cats, payouts, reports } from "./db/schema";
import { effectiveSex } from "./agent/rank";
import { SET_PLACE_ACTION } from "./agent/priority";
import { PRIVATE_ACTIONS, REPORT_CONFIRMED } from "./privateActions";
import { allNoteGrams, knownCatNames, getCatCard, manilaDate, publicReason, type JourneyStep } from "./public";

/**
 * One cat's story, built for a public page. Every field is written here by hand: no note, reporter, place, amount,
 * PayPal reference or approver can reach it, and the Treasurer's words pass the same filter as the feed.
 *
 * `at` is an exact time for an event and a plain date for a care step. `day` is always the Manila date to show.
 * A step still to come has `done: false` and no time.
 */
export type TimelineEntry = {
  at: string | null;
  day: string | null;
  kind: "person" | "ai" | "paypal";
  title: string;
  detail: string | null;
  ledger: boolean;
  done: boolean;
};

/** Rows that have happened, oldest first. Past this the oldest after the first are left out; the Ledger holds the money. */
export const TIMELINE_LIMIT = 16;

const CLAIM_WORD: Record<string, string> = { injured: "hurt", pregnant: "pregnant", sick: "sick" };
const KITTEN = "kitten";
const FUND_ACTION = "fund_cat";
const ASK_ACTION = "ask_for_check";
const AI_TITLE: Record<string, string> = {
  [ASK_ACTION]: "Treasurer asked a caretaker to check",
  [SET_PLACE_ACTION]: "Treasurer changed this cat's place",
  [FUND_ACTION]: "Treasurer funded this cat",
};
const STAFF_SOURCE: Record<string, string> = { caretaker: "Caretaker", vet: "Vet" };

const entry = (at: Date | string | null, over: Pick<TimelineEntry, "kind" | "title"> & Partial<TimelineEntry>): TimelineEntry => ({
  at: at instanceof Date ? at.toISOString() : at,
  day: at instanceof Date ? manilaDate(at) : at,
  detail: null,
  ledger: false,
  done: true,
  ...over,
});

/** Who the cat is in a sentence: she, he, or "this cat". Only a confirmed sex counts. */
function subject(sex: string): string {
  return sex === "female" ? "she's" : sex === "male" ? "he's" : "this cat is";
}

function reportedTitle(r: { source: string; claim: string }): string {
  if (r.claim === KITTEN) return `${r.source === "photo" ? "A photo suggests" : r.source === "neighbour" ? "Neighbour said" : `${STAFF_SOURCE[r.source]} said`} this cat may be a kitten`;
  const word = CLAIM_WORD[r.claim];
  if (r.source === "photo") return `A photo suggests this cat is ${word}`;
  return `${r.source === "neighbour" ? "Neighbour" : STAFF_SOURCE[r.source]} reported ${word}`;
}

const predicate = (claim: string) => (claim === KITTEN ? "a kitten" : CLAIM_WORD[claim]);

export async function catTimeline(catId: string, journeySteps?: JourneyStep[]): Promise<TimelineEntry[]> {
  const [catRows, reportRows, actionRows, payoutRows, names, notes, steps] = await Promise.all([
    db.select({ name: cats.name, sex: cats.sex, sexUnconfirmed: cats.sexUnconfirmed }).from(cats).where(eq(cats.id, catId)),
    db
      .select({ id: reports.id, claim: reports.claim, source: reports.source, status: reports.status, decidedBy: reports.decidedBy, decidedAt: reports.decidedAt, createdAt: reports.createdAt })
      .from(reports)
      .where(eq(reports.catId, catId))
      .orderBy(asc(reports.createdAt), asc(reports.id)),
    // This cat's own actions only, by the id the action recorded. The private ones are read for their time and nothing else.
    db.execute(sql`
      select a.id, a.action, a.reason, a.created_at, a.inputs->>'reportId' as report_id
      from agent_actions a
      where a.inputs->>'catId' = ${catId}
        and (a.action in (${FUND_ACTION}, ${ASK_ACTION}, ${SET_PLACE_ACTION}) or a.action = ${REPORT_CONFIRMED})
      order by a.created_at, a.id
    `),
    db
      .select({ kind: payouts.kind, status: payouts.status, createdAt: payouts.createdAt })
      .from(payouts)
      .where(eq(payouts.catId, catId))
      .orderBy(asc(payouts.createdAt), asc(payouts.id)),
    knownCatNames(),
    allNoteGrams(),
    journeySteps ? Promise.resolve(journeySteps) : getCatCard(catId).then((c) => c?.cat.journey ?? []),
  ]);
  const cat = catRows[0];
  if (!cat) return [];
  const sex = subject(effectiveSex(cat));
  const out: TimelineEntry[] = [];

  const confirmedAt = new Map<string, Date>();
  for (const a of actionRows.rows as { id: string; action: string; reason: string; created_at: Date | string; report_id: string | null }[]) {
    const at = new Date(a.created_at);
    if (a.action === REPORT_CONFIRMED) {
      if (a.report_id) confirmedAt.set(a.report_id, at);
      continue;
    }
    if ((PRIVATE_ACTIONS as readonly string[]).includes(a.action)) continue;
    out.push(entry(at, { kind: "ai", title: AI_TITLE[a.action], detail: publicReason(a.action, a.reason, cat.name, names, notes) }));
  }

  const clearedAt = new Set<number>();
  for (const r of reportRows) {
    // Closed because the cat already had it, with nobody deciding: nothing happened that a neighbour should read.
    if (r.status === "dismissed" && r.decidedBy === null) continue;
    out.push(entry(r.createdAt, { kind: "person", title: reportedTitle(r) }));
    const staffFiled = r.source === "caretaker" || r.source === "vet";
    const decidedAt = r.decidedAt;
    if (r.status === "confirmed" && decidedAt && !staffFiled) {
      out.push(entry(decidedAt, { kind: "person", title: `Caretaker confirmed ${sex} ${predicate(r.claim)}` }));
    } else if (r.status === "dismissed" && decidedAt) {
      out.push(entry(decidedAt, { kind: "person", title: "A caretaker checked this report and closed it." }));
    } else if (r.status === "cleared" && decidedAt) {
      const confirmed = confirmedAt.get(r.id);
      if (confirmed && !staffFiled) out.push(entry(confirmed, { kind: "person", title: `Caretaker confirmed ${sex} ${predicate(r.claim)}` }));
      // Cats cleared together share one moment: one row.
      if (!clearedAt.has(decidedAt.getTime())) {
        clearedAt.add(decidedAt.getTime());
        out.push(entry(decidedAt, { kind: "person", title: "Vet cleared this cat for surgery" }));
      }
    }
  }

  for (const p of payoutRows) {
    const what = p.kind === "deposit" ? "deposit" : "balance";
    const Cap = what === "deposit" ? "Deposit" : "Balance";
    let title: string;
    let detail: string | null = null;
    if (p.status === "succeeded") title = `${Cap} paid through PayPal`;
    else if (p.status === "sent" || p.status === "queued") {
      title = "Waiting for PayPal";
      detail = `The ${what} is on its way to the vet.`;
    } else if (p.status === "awaiting_approval") {
      title = "Waiting for a caretaker";
      detail = `A caretaker signs off the ${what} first.`;
    }
    else if (p.status === "needs_review") title = `A ${what === "deposit" ? "deposit is" : "balance payment is"} being checked`;
    else if (p.status === "rejected") title = what === "deposit" ? "A deposit wasn't paid" : "A balance payment wasn't paid";
    else title = what === "deposit" ? "A deposit didn't go through" : "A balance payment didn't go through";
    out.push(entry(p.createdAt, { kind: "paypal", title, detail, ledger: true }));
  }

  // Care steps: a step with a date sorts in; a step done without a date goes after them; Spotted is always first.
  const todo: TimelineEntry[] = [];
  for (const s of steps) {
    const title = s.step === "Spotted" ? "First spotted" : s.step;
    if (!s.done) todo.push({ at: null, day: null, kind: "person", title: s.step, detail: null, ledger: false, done: false });
    else out.push(entry(s.date ?? null, { kind: "person", title, detail: s.note ?? null }));
  }

  const rank = (e: TimelineEntry) => (e.at === null ? (e.title === "First spotted" ? "" : "￿") : e.at);
  const done = out.sort((a, b) => rank(a).localeCompare(rank(b)));
  // Past the limit the first row stays, so the story still starts at the start.
  const kept = done.length > TIMELINE_LIMIT ? [done[0], ...done.slice(done.length - (TIMELINE_LIMIT - 1))] : done;
  return [...kept, ...todo];
}
