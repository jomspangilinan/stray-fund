import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { agentActions, catPriority, cats, reports } from "../db/schema";
import { heldCatIds } from "../reports";
import { rankWaitingCats, type RankedCat } from "./rank";

/*
 * The order cats are funded in: rank.ts with the treasurer's moves on top. A move puts one cat directly before
 * another (or last). Only moved cats are stored, and the order is rebuilt on every read from rank.ts, the live
 * reports and the stored moves, so:
 *  - a cat that newly ranks higher keeps its place above moved cats;
 *  - a move whose report is dismissed lapses with no AI run;
 *  - a move whose cat or anchor has left the list is skipped, and applies again if they return.
 * A move that puts a cat above one rank.ts ranks higher needs a report a person checked (confirmed, or cleared by a
 * vet) on one of the two cats of every pair it inverts. Only the order changes: no money, no cat status. Cats on
 * hold never appear.
 */

export const SET_PLACE_ACTION = "set_cat_place";

export type WaitingRow = Pick<typeof cats.$inferSelect, "id" | "name" | "sex" | "sexUnconfirmed" | "flags" | "queuedAt" | "createdAt">;
export type PlacedCat = RankedCat<WaitingRow> & { moved: boolean };

/** One stored move. `beforeCatId` null means last. */
export type Move = { catId: string; beforeCatId: string | null; reportId: string | null; updatedAt: Date };

type Success = { ok: true; [key: string]: unknown };
type Failure = { ok: false; code: string; message: string; [key: string]: unknown };
export type PlaceOutcome = Success | Failure;

const fail = (code: string, message: string, extra: object = {}): Failure => ({ ok: false, code, message, ...extra });

export async function loadWaiting(tx: Tx | typeof db): Promise<WaitingRow[]> {
  return tx
    .select({
      id: cats.id,
      name: cats.name,
      sex: cats.sex,
      sexUnconfirmed: cats.sexUnconfirmed,
      flags: cats.flags,
      queuedAt: cats.queuedAt,
      createdAt: cats.createdAt,
    })
    .from(cats)
    .where(eq(cats.status, "queued"));
}

/** Queued cats that are not on hold, in rank.ts order. */
async function rankedAvailable(tx: Tx | typeof db, now: Date): Promise<RankedCat<WaitingRow>[]> {
  const [waiting, held] = await Promise.all([loadWaiting(tx), heldCatIds(tx)]);
  return rankWaitingCats(
    waiting.filter((c) => !held.has(c.id)),
    now,
  );
}

const CHECKED = ["confirmed", "cleared"];

/** Cats with a report a person checked: confirmed by a caretaker, or cleared by a vet. Any claim. */
async function checkedCats(tx: Tx | typeof db): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ catId: reports.catId })
    .from(reports)
    .where(and(inArray(reports.status, CHECKED), isNotNull(reports.catId)));
  return new Set(rows.flatMap((r) => (r.catId ? [r.catId] : [])));
}

/** Stored moves whose report, if they cite one, is still checked. Others stay stored but do not apply. */
async function liveMoves(tx: Tx | typeof db): Promise<Move[]> {
  const rows = await tx
    .select({ catId: catPriority.catId, beforeCatId: catPriority.beforeCatId, reportId: catPriority.reportId, updatedAt: catPriority.updatedAt, reportStatus: reports.status })
    .from(catPriority)
    .leftJoin(reports, eq(reports.id, catPriority.reportId))
    .orderBy(asc(catPriority.updatedAt), asc(catPriority.catId));
  return rows
    .filter((r) => r.reportId === null || (r.reportStatus !== null && CHECKED.includes(r.reportStatus)))
    .map((r) => ({ catId: r.catId, beforeCatId: r.beforeCatId, reportId: r.reportId, updatedAt: r.updatedAt }));
}

type Attempt = { order: RankedCat[] } | { skipped: "absent" } | { skipped: "unchecked"; unchecked: [string, string][] };

/** Tries one move on an order. Every pair it turns against rank.ts needs a checked cat. */
function tryMove(order: RankedCat[], move: Move, checked: Set<string>, rankIndex: Map<string, number>): Attempt {
  const from = order.findIndex((r) => r.cat.id === move.catId);
  if (from < 0) return { skipped: "absent" };
  if (move.beforeCatId === move.catId) return { skipped: "absent" };
  const without = order.filter((r) => r.cat.id !== move.catId);
  const at = move.beforeCatId === null ? without.length : without.findIndex((r) => r.cat.id === move.beforeCatId);
  if (at < 0) return { skipped: "absent" };
  const next = [...without.slice(0, at), order[from], ...without.slice(at)];

  const unchecked: [string, string][] = [];
  next.forEach((r, i) => {
    if (r.cat.id === move.catId) return;
    const wasAbove = order.findIndex((o) => o.cat.id === r.cat.id) < from;
    const isAbove = i < at;
    if (wasAbove === isAbove) return;
    const [upper, lower] = isAbove ? [r.cat.id, move.catId] : [move.catId, r.cat.id];
    // Only a pair that now disagrees with rank.ts needs a reason.
    if (rankIndex.get(upper)! > rankIndex.get(lower)! && !checked.has(upper) && !checked.has(lower)) unchecked.push([upper, lower]);
  });
  return unchecked.length > 0 ? { skipped: "unchecked", unchecked } : { order: next };
}

function applyDetailed(ranked: RankedCat[], moves: Move[], checked: Set<string>): { order: RankedCat[]; moved: Set<string> } {
  const rankIndex = new Map(ranked.map((r, i) => [r.cat.id, i]));
  const sorted = [...moves].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.catId.localeCompare(b.catId));
  let order = ranked;
  const moved = new Set<string>();
  for (const m of sorted) {
    const tried = tryMove(order, m, checked, rankIndex);
    if ("order" in tried) {
      order = tried.order;
      moved.add(m.catId);
    }
  }
  return { order, moved };
}

/**
 * `ranked` is rank.ts order with held and non-queued cats already removed. `checked` holds the cats that have a
 * confirmed or vet-cleared report. Moves apply oldest first. A move is skipped when its cat or anchor is absent, or
 * when it turns a pair against rank.ts and neither cat of that pair is checked.
 */
export function applyMoves(ranked: RankedCat[], moves: Move[], checked: Set<string>): RankedCat[] {
  return applyDetailed(ranked, moves, checked).order;
}

/** The funding order. Held and non-queued cats are not in it. */
export async function fundingOrder(tx: Tx | typeof db, now: Date): Promise<PlacedCat[]> {
  const [ranked, checked, moves] = await Promise.all([rankedAvailable(tx, now), checkedCats(tx), liveMoves(tx)]);
  const { order, moved } = applyDetailed(ranked, moves, checked);
  return order.map((r) => ({ ...(r as RankedCat<WaitingRow>), moved: moved.has(r.cat.id) }));
}

const nameList = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Moves a cat before another, or last when beforeCatId is null. Call inside the colony lock. A refusal writes
 * nothing. On success the cat's one stored move is replaced (or deleted, if the move only restores the order the
 * other moves already give) and one agent action is recorded with the reason as written.
 */
export async function placeCat(
  tx: Tx,
  input: { catId: string; beforeCatId: string | null; reason: string; reportId: string | null },
  now: Date,
): Promise<PlaceOutcome> {
  const [ranked, checked, moves] = await Promise.all([rankedAvailable(tx, now), checkedCats(tx), liveMoves(tx)]);
  const names = new Map(ranked.map((r) => [r.cat.id, r.cat.name]));
  const here = (id: string) => names.has(id);

  if (!here(input.catId)) {
    return fail("CAT_NOT_PLACEABLE", "That cat is not waiting for funding, or it still needs a person to check it first.");
  }
  if (input.beforeCatId !== null && (input.beforeCatId === input.catId || !here(input.beforeCatId))) {
    return fail("CAT_NOT_PLACEABLE", "The cat to place it before must be another cat that is waiting for funding and is not on hold.");
  }

  let cited = new Set<string>();
  if (input.reportId) {
    const [report] = await tx.select({ catId: reports.catId, status: reports.status }).from(reports).where(eq(reports.id, input.reportId));
    if (!report) return fail("REPORT_NOT_FOUND", "There is no report with that id.");
    if (!CHECKED.includes(report.status)) {
      return fail("REPORT_NOT_CHECKED", `That report is ${report.status}. Only a report a caretaker confirmed or a vet cleared can justify going against the ranking.`);
    }
    if (report.catId) cited = new Set([report.catId]);
  }

  const base = applyDetailed(ranked, moves.filter((m) => m.catId !== input.catId), checked).order;
  const move: Move = { catId: input.catId, beforeCatId: input.beforeCatId, reportId: input.reportId, updatedAt: now };
  const rankIndex = new Map(ranked.map((r, i) => [r.cat.id, i]));

  const at = base.findIndex((r) => r.cat.id === input.catId);
  const alreadyThere = input.beforeCatId === null ? at === base.length - 1 : base[at + 1]?.cat.id === input.beforeCatId;

  let needsReport = false;
  let result: number;
  if (alreadyThere) {
    result = at + 1;
  } else {
    const tried = tryMove(base, move, cited, rankIndex);
    if (!("order" in tried)) {
      const unchecked = "unchecked" in tried ? tried.unchecked : [];
      const passed = [...new Set(unchecked.map(([u, l]) => (u === input.catId ? names.get(l) : names.get(u)) ?? ""))].filter(Boolean);
      return fail(
        "MOVE_NOT_ALLOWED",
        input.reportId
          ? `That report does not cover this move. It must be about ${names.get(input.catId)} or about each cat it goes against the ranking with (${nameList(passed)}).`
          : `That goes against the ranking (${nameList(passed)}). Waiting time alone is not enough: cite a report a caretaker confirmed or a vet cleared, on ${names.get(input.catId)} or on each of those cats, or follow the ranking.`,
        { against: passed },
      );
    }
    result = tried.order.findIndex((r) => r.cat.id === input.catId) + 1;
    needsReport = !("order" in tryMove(base, move, new Set(), rankIndex));
  }

  await tx.delete(catPriority).where(eq(catPriority.catId, input.catId));
  if (!alreadyThere) {
    await tx.insert(catPriority).values({
      catId: input.catId,
      beforeCatId: input.beforeCatId,
      // Kept only when the move needs it, so a report that was not needed cannot undo it later.
      reportId: needsReport ? input.reportId : null,
      reason: input.reason,
      // The clock, not `now`: moves are told apart by when they were made, and a test's fixed time would tie them.
      updatedAt: sql`clock_timestamp()`,
    });
  }
  await tx.insert(agentActions).values({
    action: SET_PLACE_ACTION,
    reason: input.reason,
    status: "done",
    inputs: { catId: input.catId, beforeCatId: input.beforeCatId, reportId: input.reportId },
  });
  return { ok: true, catId: input.catId, catName: names.get(input.catId), place: result, of: base.length };
}
