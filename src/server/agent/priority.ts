import { eq } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { agentActions, catPriority, cats, reports } from "../db/schema";
import { heldCatIds } from "../reports";
import { rankWaitingCats, type RankedCat } from "./rank";

/*
 * The order cats are funded in. rank.ts is the starting suggestion. The treasurer can place cats ahead of it, but
 * only the order changes here: no money, no cat status. Cats on hold never appear, and a placement of a cat that
 * is no longer queued or is held is ignored. Moving a cat above one that rank.ts ranks higher needs a confirmed
 * report on one of the two cats, so a note, a wait or an open report can never buy a place.
 */

export const SET_PLACE_ACTION = "set_cat_place";

export type WaitingRow = Pick<typeof cats.$inferSelect, "id" | "name" | "sex" | "sexUnconfirmed" | "flags" | "queuedAt" | "createdAt">;
export type PlacedCat = RankedCat<WaitingRow> & { placed: boolean };

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

/** Placed cats by position, then unplaced cats in rank.ts order. Held and non-queued cats are not in it. */
export async function fundingOrder(tx: Tx | typeof db, now: Date): Promise<PlacedCat[]> {
  const ranked = await rankedAvailable(tx, now);
  const rows = await tx.select({ catId: catPriority.catId, position: catPriority.position }).from(catPriority);
  const position = new Map(rows.map((r) => [r.catId, r.position]));
  const placed = ranked.filter((r) => position.has(r.cat.id)).sort((a, b) => position.get(a.cat.id)! - position.get(b.cat.id)!);
  const rest = ranked.filter((r) => !position.has(r.cat.id));
  return [...placed.map((r) => ({ ...r, placed: true })), ...rest.map((r) => ({ ...r, placed: false }))];
}

/**
 * The shortest prefix of the wanted order that, followed by the rest in rank order, gives the wanted order. Only
 * these cats need a row.
 */
function minimalPrefix(wanted: string[], rankOrder: string[]): string[] {
  for (let k = 0; k <= wanted.length; k++) {
    const prefix = new Set(wanted.slice(0, k));
    const rebuilt = [...wanted.slice(0, k), ...rankOrder.filter((id) => !prefix.has(id))];
    if (rebuilt.every((id, i) => id === wanted[i])) return wanted.slice(0, k);
  }
  return wanted;
}

/** Pairs (upper, lower) where `upper` is above `lower` here but rank.ts has `lower` first. */
function inversions(order: string[], rankIndex: Map<string, number>): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      if (rankIndex.get(order[i])! > rankIndex.get(order[j])!) out.push([order[i], order[j]]);
    }
  }
  return out;
}

/**
 * Places a cat before another, or last when beforeCatId is null. Call inside the colony lock. A refusal writes
 * nothing. On success every placement is rewritten and one agent action is recorded with the reason as written.
 */
export async function placeCat(
  tx: Tx,
  input: { catId: string; beforeCatId: string | null; reason: string; reportId: string | null },
  now: Date,
): Promise<PlaceOutcome> {
  const ranked = await rankedAvailable(tx, now);
  const current = (await fundingOrder(tx, now)).map((r) => r.cat.id);
  const names = new Map(ranked.map((r) => [r.cat.id, r.cat.name]));

  if (!current.includes(input.catId)) {
    return fail("CAT_NOT_PLACEABLE", "That cat is not waiting for funding, or it still needs a person to check it first.");
  }
  if (input.beforeCatId !== null && (input.beforeCatId === input.catId || !current.includes(input.beforeCatId))) {
    return fail("CAT_NOT_PLACEABLE", "The cat to place it before must be another cat that is waiting for funding and is not on hold.");
  }

  const without = current.filter((id) => id !== input.catId);
  const at = input.beforeCatId === null ? without.length : without.indexOf(input.beforeCatId);
  const wanted = [...without.slice(0, at), input.catId, ...without.slice(at)];

  const rankOrder = ranked.map((r) => r.cat.id);
  const rankIndex = new Map(rankOrder.map((id, i) => [id, i]));
  const before = new Set(inversions(current, rankIndex).map(([u, l]) => `${u}|${l}`));
  const added = inversions(wanted, rankIndex).filter(([u, l]) => !before.has(`${u}|${l}`));

  if (added.length > 0) {
    if (!input.reportId) {
      return fail(
        "REPORT_REQUIRED",
        "That puts a cat above one the ranking puts first. Waiting time alone is not enough: cite a confirmed report on one of the two cats, or follow the ranking.",
        { passesOver: [...new Set(added.map(([, l]) => names.get(l)))] },
      );
    }
    const [report] = await tx.select({ id: reports.id, catId: reports.catId, status: reports.status }).from(reports).where(eq(reports.id, input.reportId));
    if (!report) return fail("REPORT_NOT_FOUND", "There is no report with that id.");
    if (report.status !== "confirmed") {
      return fail("REPORT_NOT_CONFIRMED", `That report is ${report.status}. Only a report a caretaker has confirmed can justify going against the ranking.`);
    }
    if (!report.catId || !added.every(([u, l]) => u === report.catId || l === report.catId)) {
      return fail("REPORT_NOT_ABOUT_THESE_CATS", "The report must be about the cat you move or about each cat it goes above.");
    }
  }

  const previous = await tx.select({ catId: catPriority.catId, reason: catPriority.reason }).from(catPriority);
  const oldReason = new Map(previous.map((p) => [p.catId, p.reason]));
  const stored = minimalPrefix(wanted, rankOrder);
  await tx.delete(catPriority);
  if (stored.length > 0) {
    await tx.insert(catPriority).values(
      stored.map((id, i) => ({
        catId: id,
        position: i + 1,
        reason: id === input.catId ? input.reason : (oldReason.get(id) ?? input.reason),
        updatedAt: now,
      })),
    );
  }
  await tx.insert(agentActions).values({
    action: SET_PLACE_ACTION,
    reason: input.reason,
    status: "done",
    inputs: { catId: input.catId, beforeCatId: input.beforeCatId, reportId: input.reportId },
  });
  return { ok: true, catId: input.catId, catName: names.get(input.catId), place: wanted.indexOf(input.catId) + 1, of: wanted.length };
}
