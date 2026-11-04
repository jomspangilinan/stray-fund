/*
 * What staff are told when a hurt, pregnant or sick report is on a cat that is already funded or booked. Money does
 * not stop for it. People see it where they act. Only the claim word and the status come in, never the note.
 */

export type ReportNotice = { claim: string; status: string };

const WORD: Record<string, string> = { injured: "hurt", pregnant: "pregnant", sick: "sick" };

const word = (n: ReportNotice) => WORD[n.claim] ?? null;

/** For the caretaker's approval card. */
export function approvalNotice(n: ReportNotice | null): string | null {
  const w = n && word(n);
  if (!n || !w) return null;
  if (n.status === "open") return `This cat has an open report: ${w}. Check it above before you approve.`;
  if (n.status === "confirmed") return `A caretaker confirmed this cat is ${w}. A vet has not cleared it yet.`;
  return null;
}

/** For the vet's booking. */
export function vetNotice(n: ReportNotice | null): string | null {
  const w = n && word(n);
  if (!n || !w) return null;
  if (n.status === "confirmed") return `A caretaker confirmed this cat is ${w}.`;
  if (n.status === "open") return `A neighbour says this cat is ${w}. A caretaker hasn't checked yet.`;
  return null;
}
