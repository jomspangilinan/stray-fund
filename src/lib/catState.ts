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
 * A caretaker can take a wrong already-neutered call back with neutered -> queued, under the
 * same no-money rule (see catUndoNeutered in server/caretaker/cats.ts).
 */
const ALLOWED: Record<CatStatus, readonly CatStatus[]> = {
  spotted: ["queued", "neutered"],
  queued: ["funded", "neutered"],
  funded: ["booked"],
  booked: ["in_care"],
  in_care: ["neutered"],
  neutered: ["adoptable", "queued"],
  adoptable: ["adopted"],
  adopted: [],
};

export function canTransition(from: CatStatus, to: CatStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Neighbours are asked about a cat from the day it is spotted until it is in care. After that the vet's photo decides. */
export function earTipAskable(status: string): boolean {
  return status === "spotted" || status === "queued" || status === "funded" || status === "booked" || status === "in_care";
}
