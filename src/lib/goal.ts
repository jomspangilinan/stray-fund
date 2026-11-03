/** Share of the goal reached, 0 to 100, never above the goal. */
export function goalPercent(done: number, goal: number): number {
  if (!(goal > 0) || !(done > 0)) return 0;
  return Math.min(100, Math.round((done / goal) * 100));
}
