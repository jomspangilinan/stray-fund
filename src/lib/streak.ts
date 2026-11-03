/*
 * A gentle weekly streak. A week counts when the person had at least one accepted sighting in it (a spot
 * that also finishes a mission is the same sighting). Weeks are Monday to Sunday in Asia/Manila.
 * Donations never count. Only the positive is shown: a gap never reads as lost.
 */

const MANILA_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** A whole-number week, Monday start, Asia/Manila (no daylight saving). 1970-01-05 was a Monday. */
export function weekIndex(d: Date): number {
  const days = Math.floor((d.getTime() + MANILA_OFFSET_MS) / DAY_MS);
  return Math.floor((days + 3) / 7);
}

export type Streak = {
  /** Weeks in a row, ending this week or last week. 0 after a gap. */
  current: number;
  /** Every week with a sighting. Only ever goes up. */
  total: number;
};

export function streakOf(dates: Date[], now: Date): Streak {
  const weeks = new Set(dates.filter((d) => d.getTime() <= now.getTime() + 7 * DAY_MS).map(weekIndex));
  const total = weeks.size;
  const thisWeek = weekIndex(now);
  // This week may still be empty without breaking anything, so a run can end last week.
  let w = weeks.has(thisWeek) ? thisWeek : thisWeek - 1;
  let current = 0;
  while (weeks.has(w)) {
    current++;
    w--;
  }
  return { current, total };
}

const weeks = (n: number) => `${n} ${n === 1 ? "week" : "weeks"}`;

/** Nothing for someone with no weeks yet; the screen invites a first spot instead. */
export function streakLabel(s: Streak): string | null {
  if (s.total === 0) return null;
  if (s.current === s.total) return `${weeks(s.total)} helping`;
  return `Welcome back. ${weeks(s.total)} helping so far.`;
}
