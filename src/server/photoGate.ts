import type { Box } from "./photos";

/*
 * A fresh photo the AI matched or started a cat with publishes at once: everything but the cat is blurred, and the
 * listed regions are blurred again. These rules are for the caretaker's own steps. An empty list of regions does not
 * mean safe: it can mean the model missed something. The model must also say, in its own field, that once the listed
 * regions are blurred nothing else is left (no readable text, sign, plate, house number or face). A row saved before
 * the field existed has no answer.
 */

type Stored = { sensitive_regions?: unknown; no_sensitive_content?: unknown } | null | undefined;

export function regionsOf(assessment: unknown): Box[] {
  const r = (assessment as Stored)?.sensitive_regions;
  return Array.isArray(r) ? (r as Box[]) : [];
}

/** True only when the model listed its regions and said nothing else sensitive is left. Confirming a sighting from review publishes only then. */
export function autoPublishable(assessment: unknown): boolean {
  const a = assessment as Stored;
  return Array.isArray(a?.sensitive_regions) && a?.no_sensitive_content === true;
}

/** The caretaker ticks the box unless the model both listed regions and was sure nothing else is left. */
export function needsHumanTick(assessment: unknown): boolean {
  const a = assessment as Stored;
  if (regionsOf(assessment).length === 0) return true;
  return a?.no_sensitive_content === false;
}
