import { describe, expect, it } from "vitest";
import { buildCards } from "../src/lib/swipeCards";
import type { PayoutItem, ReceiptItem, ReportItem } from "../src/server/caretaker/queue";

const report = (over: Partial<ReportItem> = {}): ReportItem => ({
  id: "r1",
  claim: "injured",
  source: "neighbour",
  catId: "c1",
  catName: "Hapon",
  sightingId: "s1",
  note: "Limping on the back left leg",
  photoAgrees: true,
  checkQuestion: null,
  exact: null,
  area: "Brgy. San Antonio",
  exactHidden: false,
  ...over,
});

const payout = (over: Partial<PayoutItem> = {}): PayoutItem =>
  ({
    id: "p1",
    kind: "deposit",
    amount: 50000,
    status: "awaiting_approval",
    catId: "c1",
    catName: "Hapon",
    vetName: "Dr. Reyes",
    date: "2026-11-12",
    agentReason: "Hapon is a pregnant female and waited longest.",
    batchId: null,
    attempts: 0,
    lastGatewayError: null,
    bookingId: "b1",
    itemStatus: null,
    lateSuccess: false,
    canRuleNotPaid: false,
    canRulePaid: false,
    canAllowRetry: false,
    catReport: null,
    ...over,
  }) as PayoutItem;

const receipt = (over: Partial<ReceiptItem> = {}): ReceiptItem =>
  ({
    id: "e1",
    bookingId: "b1",
    catName: "Hapon",
    vetName: "Dr. Reyes",
    clinicName: "Paws Clinic",
    date: "2026-11-12",
    reasons: [],
    reasonMessages: [],
    parsed: { clinic: "Paws Clinic", date: "2026-11-12", total_centavos: 150000, currency: "PHP", receipt_number: "1", cat_name: "Hapon", items: ["Spay"], tamper_signs: [] },
    depositPaid: 50000,
    packagePrice: 150000,
    ...over,
  }) as ReceiptItem;

const empty = { reports: [], awaitingApproval: [], receipts: [], earTipConfirmations: [] };

describe("swipe desk cards", () => {
  it("makes a report card that confirms right and dismisses left, leaning on the photo check", () => {
    const [card] = buildCards({ ...empty, reports: [report()] });
    expect(card).toMatchObject({ kind: "report", anchor: "desk-report-r1", suggest: "right", photo: "/api/caretaker/images/sighting/s1" });
    expect(card.right).toEqual({ label: "Confirm", action: "report_confirm", body: { reportId: "r1" } });
    expect(card.left).toEqual({ label: "Dismiss", action: "report_dismiss", body: { reportId: "r1" } });
    expect(buildCards({ ...empty, reports: [report({ photoAgrees: false })] })[0].suggest).toBe("left");
    expect(buildCards({ ...empty, reports: [report({ photoAgrees: null })] })[0].suggest).toBeNull();
  });

  it("leaves a report on an unsorted cat in the list", () => {
    expect(buildCards({ ...empty, reports: [report({ catId: null, catName: null })] })).toEqual([]);
  });

  it("makes an approval card that sends right and needs a reason to reject", () => {
    const [card] = buildCards({ ...empty, awaitingApproval: [payout()] });
    expect(card.right).toEqual({ label: "Approve and send ₱500", action: "payout_approve", body: { payoutId: "p1" } });
    expect(card.left).toBeNull();
    expect(card.suggest).toBe("right");
    expect(card.ai).toContain("Hapon is a pregnant female");
  });

  it("never suggests approving a payout for a cat with an open report", () => {
    const [card] = buildCards({ ...empty, awaitingApproval: [payout({ catReport: { claim: "injured", status: "open", source: "neighbour" } as PayoutItem["catReport"] })] });
    expect(card.suggest).toBe("left");
    expect(card.facts.join(" ")).toContain("open report");
  });

  it("makes a receipt card only when every check passed and the total fits", () => {
    const [card] = buildCards({ ...empty, receipts: [receipt()] });
    expect(card.right).toMatchObject({ action: "evidence_accept", body: { receiptId: "e1", total: "1500", earTipConfirmed: "on" } });
    expect(card.right.body.note).toContain("₱1,500.00");
    for (const bad of [
      receipt({ reasons: ["TOTAL_MISMATCH"] as ReceiptItem["reasons"] }),
      receipt({ parsed: { ...receipt().parsed!, total_centavos: null } }),
      receipt({ parsed: { ...receipt().parsed!, total_centavos: 50000 } }),
      receipt({ parsed: { ...receipt().parsed!, total_centavos: 150001 } }),
      receipt({ parsed: { ...receipt().parsed!, tamper_signs: ["pasted block"] } }),
    ]) {
      expect(buildCards({ ...empty, receipts: [bad] })).toEqual([]);
    }
  });

  it("makes an ear-tip card with the vet's photo, in desk order after reports and approvals", () => {
    const cards = buildCards({ reports: [report()], awaitingApproval: [payout()], receipts: [], earTipConfirmations: [receipt({ id: "e2" })] });
    expect(cards.map((c) => c.kind)).toEqual(["report", "approval", "eartip"]);
    expect(cards[2].right).toEqual({ label: "I see the ear tip", action: "evidence_confirm_ear_tip", body: { receiptId: "e2" } });
    expect(cards[2].photo).toBe("/api/caretaker/images/eartip/e2");
  });
});

describe("swipe desk cards for cat details", () => {
  it("turns ear-tip votes and name ideas into cards labelled as neighbours' word, after the money cards", () => {
    const cards = buildCards({
      reports: [],
      awaitingApproval: [payout()],
      receipts: [],
      earTipConfirmations: [],
      earTipPending: [{ id: "c9", name: "Oliver", yes: 2, no: 0, exact: null, area: "Brgy. San Antonio", exactHidden: false }],
      nameSuggestions: [{ id: "n1", catId: "c9", catName: "Oliver", name: "Mochi", photoSightingId: null, date: "2026-11-12" }],
    });
    expect(cards.map((c) => c.kind)).toEqual(["approval", "ears", "name"]);
    const [, ears, name] = cards;
    expect(ears).toMatchObject({ aiLabel: "Neighbours say", suggest: "right", anchor: "desk-ears-c9" });
    expect(ears.right.body).toEqual({ catId: "c9", earTip: "present" });
    expect(ears.left?.body).toEqual({ catId: "c9", earTip: "absent" });
    expect(name.right).toEqual({ label: "Use the name", action: "name_approve", body: { suggestionId: "n1" } });
    expect(name.left).toEqual({ label: "Dismiss", action: "name_dismiss", body: { suggestionId: "n1" } });
  });
});
