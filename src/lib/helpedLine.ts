import { formatPesoShort } from "./money";

/** What the person did for a cat, in their own words: "You spotted, named and gave ₱200". */
export function helpedLine({ spotted, named, amount }: { spotted: boolean; named: boolean; amount: number }): string {
  const parts: string[] = [];
  if (spotted) parts.push("spotted");
  if (named) parts.push("named");
  if (amount > 0) parts.push(`gave ${formatPesoShort(amount)}`);
  const last = parts.pop();
  if (!last) return "";
  return `You ${parts.length ? `${parts.join(", ")} and ` : ""}${last}`;
}
