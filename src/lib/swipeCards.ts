import { formatPeso, formatPesoShort } from "@/lib/money";
import { approvalNotice } from "@/lib/reportNotice";
import type { CaretakerQueue, PayoutItem, ReceiptItem, ReportItem } from "@/server/caretaker/queue";

/** One action a card can send: the same route and body today's form posts. */
export type SwipeMove = { label: string; action: string; body: Record<string, string> };

/**
 * One yes-or-no decision on the swipe desk. Right is always the green action. A null `left` means the other
 * choice needs words (a reason or a note), so a left swipe opens the full form instead of sending anything.
 */
export type SwipeCard = {
  id: string;
  /** The id of this item's full form in the list below the stack. */
  anchor: string;
  kind: "report" | "approval" | "receipt" | "eartip" | "ears" | "name";
  title: string;
  facts: string[];
  /** Whose read this is: "Claude read this", or "Neighbours say" where no AI is involved. */
  aiLabel: string;
  /** What the AI (or the neighbours) said, in one or two plain sentences. Model text is shown as text only. */
  ai: string;
  /** Which way the AI leans. Null when it has nothing to go on. */
  suggest: "right" | "left" | null;
  right: SwipeMove;
  left: SwipeMove | null;
  leftLabel: string;
  photo: string | null;
  /** The sighting behind `photo`, when it is one: the card then offers Rotate left and Rotate right. */
  sightingId: string | null;
};

const CLAIM_TITLE: Record<string, string> = { injured: "Hurt", pregnant: "Pregnant", sick: "Sick", kitten: "A kitten" };
const KIND: Record<string, string> = { deposit: "Deposit", balance: "Balance" };

const anchorOf = (kind: SwipeCard["kind"], id: string) => `desk-${kind}-${id}`;

function reportCard(r: ReportItem): SwipeCard | null {
  // A report on a cat nobody has sorted yet needs the photo matched first, in the list below.
  if (!r.catId) return null;
  const title = `${CLAIM_TITLE[r.claim] ?? r.claim}: ${r.catName ?? "a cat"}`;
  const who = r.source === "photo" ? "The AI's photo check flagged this" : "A neighbour reported this";
  const ai =
    r.photoAgrees === true
      ? "Claude looked at the photo and it seems to show this."
      : r.photoAgrees === false
        ? "Claude looked at the photo and doesn't clearly see this."
        : r.source === "photo"
          ? "Claude spotted this in the photo. A person should look before the cat is held."
          : r.sightingId
            ? "Claude hasn't checked this photo against the report, so look for yourself."
            : "There's no photo for Claude to check, so this one is your call.";
  const facts = [who, ...(r.note ? [`"${r.note}"`] : []), ...(r.checkQuestion ? [`The treasurer asks: ${r.checkQuestion}`] : []), r.area].filter(Boolean);
  return {
    id: r.id,
    anchor: anchorOf("report", r.id),
    kind: "report",
    title,
    facts,
    aiLabel: "Claude read this",
    ai,
    suggest: r.photoAgrees === true ? "right" : r.photoAgrees === false ? "left" : null,
    right: { label: "Confirm", action: "report_confirm", body: { reportId: r.id } },
    left: { label: "Dismiss", action: "report_dismiss", body: { reportId: r.id } },
    leftLabel: "Dismiss",
    photo: r.sightingId ? `/api/caretaker/images/sighting/${r.sightingId}` : null,
    sightingId: r.sightingId,
  };
}

function approvalCard(p: PayoutItem): SwipeCard {
  const notice = approvalNotice(p.catReport);
  return {
    id: p.id,
    anchor: anchorOf("approval", p.id),
    kind: "approval",
    title: `${formatPeso(p.amount)} to ${p.vetName}`,
    facts: [`${KIND[p.kind] ?? p.kind} for ${p.catName}, sent through PayPal Payouts`, ...(notice ? [notice] : [])],
    aiLabel: "Claude read this",
    ai: p.agentReason ? `The treasurer wrote: ${p.agentReason}` : "The treasurer asked for this payment without a written reason.",
    suggest: notice ? "left" : "right",
    right: { label: `Approve and send ${formatPesoShort(p.amount)}`, action: "payout_approve", body: { payoutId: p.id } },
    left: null,
    leftLabel: "Reject",
    photo: null,
    sightingId: null,
  };
}

/** Whole pesos, or pesos and centavos, as the receipt form takes them. */
const pesos = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

function receiptCard(r: ReceiptItem): SwipeCard | null {
  const total = r.parsed?.total_centavos ?? null;
  // Only a receipt that passed every check and whose total Claude could read inside the allowed range.
  if (r.reasons.length > 0 || total === null || total <= r.depositPaid || total > r.packagePrice || (r.parsed?.tamper_signs?.length ?? 0) > 0) return null;
  return {
    id: r.id,
    anchor: anchorOf("receipt", r.id),
    kind: "receipt",
    title: `Receipt for ${r.catName}`,
    facts: [`Vet ${r.vetName}`, `Package ${formatPeso(r.packagePrice)}, deposit paid ${formatPeso(r.depositPaid)}`],
    aiLabel: "Claude read this",
    ai: `Claude read ${formatPeso(total)}${r.parsed?.clinic ? ` from ${r.parsed.clinic}` : ""}, and it passed every check. Look for the ear tip in the photo.`,
    suggest: "right",
    right: {
      label: `Accept ${formatPesoShort(total)}, ear tip seen`,
      action: "evidence_accept",
      body: { receiptId: r.id, total: pesos(total), earTipConfirmed: "on", note: `Accepted on the swipe desk: total ${formatPeso(total)} as Claude read it, ear tip seen in the photo.` },
    },
    left: null,
    leftLabel: "Send back",
    photo: `/api/caretaker/images/eartip/${r.id}`,
    sightingId: null,
  };
}

function earTipCard(r: ReceiptItem): SwipeCard {
  const total = r.parsed?.total_centavos ?? null;
  return {
    id: r.id,
    anchor: anchorOf("eartip", r.id),
    kind: "eartip",
    title: `Ear tip: ${r.catName}`,
    facts: [`Vet ${r.vetName}`, `Package ${formatPeso(r.packagePrice)}, deposit paid ${formatPeso(r.depositPaid)}`],
    aiLabel: "Claude read this",
    ai: `Claude read the receipt${total !== null ? ` (${formatPeso(total)})` : ""} and it passed every check. Only a person can confirm the ear tip, so look at the photo.`,
    suggest: "right",
    right: { label: "I see the ear tip", action: "evidence_confirm_ear_tip", body: { receiptId: r.id } },
    left: null,
    leftLabel: "Send back",
    photo: `/api/caretaker/images/eartip/${r.id}`,
    sightingId: null,
  };
}

/** Neighbours' ear-tip votes. The AI was wrong about ear tips on real photos, so this is a person's call. */
function earsCard(c: CaretakerQueue["earTipPending"][number]): SwipeCard {
  return {
    id: c.id,
    anchor: anchorOf("ears", c.id),
    kind: "ears",
    title: `Is ${c.name}'s ear tipped?`,
    facts: [c.area].filter(Boolean),
    aiLabel: "Neighbours say",
    ai: `${c.yes} said ear-tipped, ${c.no} said not.`,
    suggest: c.yes > c.no ? "right" : c.no > c.yes ? "left" : null,
    right: { label: "Ear tipped", action: "cat_set_ear_tip", body: { catId: c.id, earTip: "present" } },
    left: { label: "Not tipped", action: "cat_set_ear_tip", body: { catId: c.id, earTip: "absent" } },
    leftLabel: "Not tipped",
    photo: null,
    sightingId: null,
  };
}

function nameCard(n: CaretakerQueue["nameSuggestions"][number]): SwipeCard {
  return {
    id: n.id,
    anchor: anchorOf("name", n.id),
    kind: "name",
    title: `Call ${n.catName} "${n.name}"?`,
    facts: [],
    aiLabel: "Neighbours say",
    ai: `A neighbour suggested the name ${n.name}.`,
    suggest: null,
    right: { label: "Use the name", action: "name_approve", body: { suggestionId: n.id } },
    left: { label: "Dismiss", action: "name_dismiss", body: { suggestionId: n.id } },
    leftLabel: "Dismiss",
    photo: n.photoSightingId ? `/api/caretaker/images/sighting/${n.photoSightingId}` : null,
    sightingId: n.photoSightingId,
  };
}

type CardQueue = Pick<CaretakerQueue, "reports" | "awaitingApproval" | "receipts" | "earTipConfirmations"> &
  Partial<Pick<CaretakerQueue, "earTipPending" | "nameSuggestions">>;

/** The swipe stack, in desk order: reports first, then payments waiting for a yes, then evidence, then cat details. */
export function buildCards(q: CardQueue): SwipeCard[] {
  return [
    ...q.reports.map(reportCard),
    ...q.awaitingApproval.map(approvalCard),
    ...q.receipts.map(receiptCard),
    ...q.earTipConfirmations.map(earTipCard),
    ...(q.earTipPending ?? []).map(earsCard),
    ...(q.nameSuggestions ?? []).map(nameCard),
  ].filter((c): c is SwipeCard => c !== null);
}
