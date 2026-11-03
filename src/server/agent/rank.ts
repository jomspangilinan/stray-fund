/** The fields the ranking uses. Cat text never reaches `why`, so it cannot steer the agent from there. */
export type RankableCat = {
  id: string;
  name: string;
  sex: string;
  /** The sex came from a neighbour and no caretaker has confirmed it, so it counts as unknown here. */
  sexUnconfirmed?: boolean;
  flags: string[];
  queuedAt: Date | null;
  createdAt: Date;
};

export type Tier = 1 | 2 | 3 | 4 | 5;

export type RankedCat<C extends RankableCat = RankableCat> = {
  cat: C;
  tier: Tier;
  waitDays: number;
  why: string;
};

const DAY_MS = 86_400_000;

const WHY: Record<Tier, string> = {
  1: "Unspayed female, so one surgery prevents the most kittens.",
  2: "Pregnant with sex not yet confirmed, so she goes ahead of the general queue.",
  3: "Injured or sick, so she or he should see a vet soon.",
  4: "A kitten, and young cats are the most at risk on the street.",
  5: "No special need, so waits by time in the queue.",
};

/** What the ranking may believe about the sex: an unconfirmed neighbour's answer is not believed. */
export const effectiveSex = (c: { sex: string; sexUnconfirmed?: boolean }): string => (c.sexUnconfirmed ? "unknown" : c.sex);

function tierOf(cat: RankableCat): Tier {
  const sex = effectiveSex(cat);
  if (sex === "female") return 1;
  if (sex === "unknown" && cat.flags.includes("pregnant")) return 2;
  if (cat.flags.includes("injured") || cat.flags.includes("sick")) return 3;
  if (cat.flags.includes("kitten")) return 4;
  return 5;
}

const waitingSince = (cat: RankableCat): Date => cat.queuedAt ?? cat.createdAt;

/** Best first: by tier, then longest wait, then id so the order never depends on the input. */
export function rankWaitingCats<C extends RankableCat>(cats: readonly C[], now: Date): RankedCat<C>[] {
  return cats
    .map((cat) => {
      const tier = tierOf(cat);
      const waited = now.getTime() - waitingSince(cat).getTime();
      return { cat, tier, waitDays: Math.max(0, Math.floor(waited / DAY_MS)), why: WHY[tier] };
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        waitingSince(a.cat).getTime() - waitingSince(b.cat).getTime() ||
        a.cat.id.localeCompare(b.cat.id),
    );
}
