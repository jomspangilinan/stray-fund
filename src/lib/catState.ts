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

/**
 * The spec chain, plus two routes for a cat that was already neutered: spotted -> neutered,
 * and queued -> neutered, which only a caretaker takes and only while no money has been
 * set aside or paid for the cat (see markAlreadyNeutered in server/caretaker/cats.ts).
 */
const ALLOWED: Record<CatStatus, readonly CatStatus[]> = {
  spotted: ["queued", "neutered"],
  queued: ["funded", "neutered"],
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
