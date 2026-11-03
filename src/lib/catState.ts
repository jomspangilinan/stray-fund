export const CAT_STATUSES = [
  "spotted",
  "queued",
  "funded",
  "booked",
  "in_care",
  "neutered",
  "adoptable",
  "adopted",
] as const;

export type CatStatus = (typeof CAT_STATUSES)[number];

/** The spec chain, plus spotted -> neutered for already ear-tipped cats. */
const ALLOWED: Record<CatStatus, readonly CatStatus[]> = {
  spotted: ["queued", "neutered"],
  queued: ["funded"],
  funded: ["booked"],
  booked: ["in_care"],
  in_care: ["neutered"],
  neutered: ["adoptable"],
  adoptable: ["adopted"],
  adopted: [],
};

export function canTransition(from: CatStatus, to: CatStatus): boolean {
  return ALLOWED[from].includes(to);
}
