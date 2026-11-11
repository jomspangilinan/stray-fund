/** The line over the Ledger grid. The filtered count shows only when a filter hides rows. */
export function ledgerCount(shown: number, total: number): string {
  const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
  return `${shown === total ? rows(total) : `${shown} of ${rows(total)}`} · tap one for details`;
}
