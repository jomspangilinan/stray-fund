import { formatPesoShort } from "./money";

/**
 * The words under the fund figure. "Ready" is only said when the free money covers one real care package,
 * the same test the treasurer uses before it funds a cat. Both numbers are centavos.
 */
export function fundLine(available: number, packagePrice: number): string {
  if (available <= 0) return "in the fund";
  if (available >= packagePrice) return "ready for the next cat";
  return `of ${formatPesoShort(packagePrice)} for the next cat`;
}
