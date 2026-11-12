import { eq } from "drizzle-orm";
import { withColonyLock, type Tx } from "../db/client";
import { reports } from "../db/schema";
import { confirmReport, dismissReport, reopenReport } from "../reports";
import { reqUuid, requireCaretaker, Refusal, type Handler, type Outcome } from "./shared";

const DECIDED = "Someone has already decided this report.";
const SORT_FIRST = "Sort this photo below first.";

/** Both taps share one path: lock, check the account, decide, and put a repeat tap or a missing cat in plain words. */
async function decide(caretakerId: string, body: Record<string, unknown>, run: (tx: Tx, id: string) => ReturnType<typeof confirmReport>, done: (claim: string) => string): Promise<Outcome> {
  const reportId = reqUuid(body, "reportId", "The report");
  return withColonyLock(async (tx) => {
    await requireCaretaker(tx, caretakerId);
    const [r] = await tx.select({ claim: reports.claim }).from(reports).where(eq(reports.id, reportId));
    if (!r) throw new Refusal(404, "There is no such report.");
    const out = await run(tx, reportId);
    if (out.ok) return done(r.claim);
    if (out.reason === "no_cat") return { tone: "warn", message: SORT_FIRST };
    // A double tap, or two caretakers at once: nothing changed, and nothing is wrong.
    return { tone: "warn", message: DECIDED };
  });
}

export const reportConfirm: Handler = (caretakerId, body) =>
  decide(
    caretakerId,
    body,
    (tx, id) => confirmReport(tx, id, caretakerId),
    (claim) => (claim === "kitten" ? "Confirmed." : "Confirmed. A vet will check the cat before surgery."),
  );

export const reportDismiss: Handler = (caretakerId, body) =>
  decide(
    caretakerId,
    body,
    (tx, id) => dismissReport(tx, id, caretakerId),
    () => "Dismissed.",
  );

/** Undo for a caretaker who got a report wrong: it goes back on the desk, open, and the cat is held again. */
export const reportReopen: Handler = async (caretakerId, body) => {
  const reportId = reqUuid(body, "reportId", "The report");
  return withColonyLock(async (tx): Promise<Outcome> => {
    await requireCaretaker(tx, caretakerId);
    const out = await reopenReport(tx, reportId, caretakerId);
    if (out.ok) return "Reopened. It's back on To check, and the cat is held until it's decided.";
    if (out.reason === "not_found") throw new Refusal(404, "There is no such report.");
    if (out.reason === "already_open") return { tone: "warn", message: "This report is already open." };
    throw new Refusal(409, "A vet has already cleared this cat, so this report stays closed.");
  });
};
