import type { CaretakerQueue } from "@/server/caretaker/queue";

/**
 * The sections of "To check", in the order they can hold up money or care. Reports about a cat come first, above payouts. The desk, its jump row and the
 * waiting line on the yard all read this one list, so the numbers cannot disagree.
 */
export const DESK_SECTIONS = [
  { id: "reports", title: "Reports to check", chip: "Reports", count: (q: CaretakerQueue) => q.reports.length },
  { id: "approvals", title: "Payouts to approve", chip: "Approve", count: (q: CaretakerQueue) => q.awaitingApproval.length },
  { id: "payout-review", title: "Payouts to rule on", chip: "Rule on", count: (q: CaretakerQueue) => q.needsReview.length },
  { id: "long-sent", title: "Sent, not confirmed", chip: "Not confirmed", count: (q: CaretakerQueue) => q.longSent.length },
  { id: "receipts", title: "Receipts", chip: "Receipts", count: (q: CaretakerQueue) => q.receipts.length },
  { id: "eartip-photos", title: "Ear-tip photos", chip: "Ear-tip photos", count: (q: CaretakerQueue) => q.earTipConfirmations.length },
  { id: "sightings", title: "Photos to sort", chip: "Photos", count: (q: CaretakerQueue) => q.sightings.length },
  { id: "reviews", title: "Treasurer questions", chip: "Questions", count: (q: CaretakerQueue) => q.reviews.length },
  { id: "wakeups", title: "Failed jobs", chip: "Failed jobs", count: (q: CaretakerQueue) => q.failedWakeups.length },
  { id: "ears", title: "Ear-tips to decide", chip: "Ear-tips", count: (q: CaretakerQueue) => q.earTipPending.length },
  { id: "neutered", title: "Neutered, no vet record", chip: "No record", count: (q: CaretakerQueue) => q.neuteredWithoutRecord.length },
  { id: "names", title: "Name ideas", chip: "Names", count: (q: CaretakerQueue) => q.nameSuggestions.length },
  { id: "photos", title: "Held-back photos", chip: "Held photos", count: (q: CaretakerQueue) => q.heldPhotos.length },
] as const;

export type DeskSectionId = (typeof DESK_SECTIONS)[number]["id"];

export const deskTitle = (id: DeskSectionId): string => DESK_SECTIONS.find((s) => s.id === id)!.title;

/** The sections that have something in them, with how many. */
export function waitingSections(q: CaretakerQueue): { id: DeskSectionId; chip: string; n: number }[] {
  return DESK_SECTIONS.map((s) => ({ id: s.id, chip: s.chip, n: s.count(q) })).filter((s) => s.n > 0);
}

export const deskTotal = (q: CaretakerQueue): number => waitingSections(q).reduce((sum, s) => sum + s.n, 0);
