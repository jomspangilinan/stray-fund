import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { milestoneSeen } from "./db/schema";
import type { HelpedEntry, PublicCat } from "./public";

export type Milestone = "neutered" | "adopted";
export type Celebration = { catId: string; catName: string; milestone: Milestone };

/** Newest event first, so a cat that has been adopted is celebrated for that before its neutering. */
const ORDER: Milestone[] = ["adopted", "neutered"];

/**
 * Milestones a cat has really reached. "Neutered" needs the fund's own neuter treatment: a cat found already
 * ear-tipped carries a note on that step, so nobody is told the vet neutered it.
 */
export function milestonesFor(cat: Pick<PublicCat, "status" | "journey">): Milestone[] {
  const out: Milestone[] = [];
  const step = cat.journey.find((j) => j.step === "Neutered");
  // A dated step comes only from a real neuter treatment, never from status alone.
  if (step?.done && step.date && !step.note) out.push("neutered");
  if (cat.status === "adopted") out.push("adopted");
  return ORDER.filter((m) => out.includes(m));
}

/** What the cat row shows as its milestone. Not a score, only where the cat is. */
export function milestoneLabel(cat: Pick<PublicCat, "status" | "journey">): string {
  const m = milestonesFor(cat);
  if (m.includes("adopted")) return "Found a home";
  if (m.includes("neutered")) return "Neutered";
  return "Waiting for the vet";
}

export function celebrationText(c: Celebration): string {
  return c.milestone === "adopted"
    ? `${c.catName} found a home. You helped fund this.`
    : `${c.catName} came home from the vet. You helped fund this.`;
}

/**
 * The one unseen milestone to show, among the cats this donor helped. The entries come from getHelpedEntries:
 * net positive allocations of this donor's captured donations. Reading marks nothing, because a page may be
 * rendered more than once; it is marked seen only after the person's browser confirms it showed.
 */
export async function findCelebration(userId: string, entries: HelpedEntry[]): Promise<Celebration | null> {
  const candidates: Celebration[] = entries.flatMap((e) =>
    milestonesFor(e.cat).map((milestone) => ({ catId: e.cat.id, catName: e.cat.name, milestone })),
  );
  if (candidates.length === 0) return null;
  const seen = await db.select().from(milestoneSeen).where(eq(milestoneSeen.userId, userId));
  const done = new Set(seen.map((s) => `${s.catId}:${s.milestone}`));
  candidates.sort(
    (a, b) => ORDER.indexOf(a.milestone) - ORDER.indexOf(b.milestone) || a.catName.localeCompare(b.catName),
  );
  return candidates.find((c) => !done.has(`${c.catId}:${c.milestone}`)) ?? null;
}

/** Marks one celebration seen. True the first time only, so it can never show twice. */
export async function markCelebrationSeen(userId: string, c: Pick<Celebration, "catId" | "milestone">): Promise<boolean> {
  const inserted = await db
    .insert(milestoneSeen)
    .values({ userId, catId: c.catId, milestone: c.milestone })
    .onConflictDoNothing()
    .returning({ catId: milestoneSeen.catId });
  return inserted.length > 0;
}

/** Marks the celebration seen only if it is true for this donor right now. */
export async function confirmCelebrationSeen(
  userId: string,
  entries: HelpedEntry[],
  claim: { catId: string; milestone: string },
): Promise<boolean> {
  const real = entries.some(
    (e) => e.cat.id === claim.catId && (milestonesFor(e.cat) as string[]).includes(claim.milestone),
  );
  if (!real) return false;
  return markCelebrationSeen(userId, { catId: claim.catId, milestone: claim.milestone as Milestone });
}
