import type { Box } from "./photos";

/*
 * When a photo may go public without a person looking. An empty list of regions does not mean safe: it can
 * mean the model missed something. The model must also say, in its own field, that once the listed regions are
 * blurred nothing else is left (no readable text, sign, plate, house number or face). Anything else waits for a
 * caretaker. A row saved before the field existed has no answer and is never published by the machine.
 */

type Stored = { sensitive_regions?: unknown; no_sensitive_content?: unknown } | null | undefined;

export function regionsOf(assessment: unknown): Box[] {
  const r = (assessment as Stored)?.sensitive_regions;
  return Array.isArray(r) ? (r as Box[]) : [];
}

/** True only when the model listed its regions and said nothing else sensitive is left. */
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
