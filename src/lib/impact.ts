import { formatPeso } from "./money";
import type { PoolStatus } from "@/server/ledger";
import type { PublicLedgerRow } from "@/server/public";

/** Payout states where the money is committed but no vet has been paid yet. Mirrors getPoolStatus. */
export const IN_FLIGHT = ["awaiting_approval", "queued", "sent", "needs_review"] as const;

/** Money coming in, or taken back out of what came in: a donation, or a refund of one (negative amount and fee). */
export const isDonationRow = (r: Pick<PublicLedgerRow, "type">) => r.type === "donation" || r.type === "refund";

export type LedgerTotals = {
  donated: number;
  paypalFees: number;
  paidToVets: number;
  payoutFees: number;
  inFlight: number;
  count: number;
};

/**
 * Pure. The grid calls this with whichever rows the filter leaves, so the pinned totals follow the
 * filter. With every row it equals getPoolStatus, which a test holds in place.
 */
export function ledgerTotals(rows: readonly PublicLedgerRow[]): LedgerTotals {
  const t: LedgerTotals = { donated: 0, paypalFees: 0, paidToVets: 0, payoutFees: 0, inFlight: 0, count: rows.length };
  for (const r of rows) {
    if (isDonationRow(r)) {
      t.donated += r.amount;
      t.paypalFees += r.fee ?? 0;
    } else if (r.status === "succeeded") {
      t.paidToVets += r.amount;
      t.payoutFees += r.fee ?? 0;
    } else if ((IN_FLIGHT as readonly string[]).includes(r.status)) {
      t.inFlight += r.amount;
    }
  }
  return t;
}

export type Conservation = {
  text: string;
  balanced: boolean;
  parts: { donated: number; paypalFees: number; paidToVets: number; payoutFees: number; held: number; pool: number };
};

/** Donated = PayPal fees + paid to vets + payout fees + set aside for cats (in-flight included) + still free. */
export function conservation(p: PoolStatus): Conservation {
  const held = p.heldForCats + p.reservedPayouts;
  const parts = {
    donated: p.grossIn,
    paypalFees: p.paypalFees,
    paidToVets: p.vetPaid,
    payoutFees: p.payoutFees,
    held,
    pool: p.available,
  };
  const balanced = parts.donated === parts.paypalFees + parts.paidToVets + parts.payoutFees + parts.held + parts.pool;
  const text =
    `Donated ${formatPeso(parts.donated)} = PayPal fees ${formatPeso(parts.paypalFees)}` +
    ` + paid to vets ${formatPeso(parts.paidToVets)} + payout fees ${formatPeso(parts.payoutFees)}` +
    ` + set aside for cats ${formatPeso(parts.held)} + still free ${formatPeso(parts.pool)}` +
    (p.reversedGross > 0 ? `. Donated is after ${formatPeso(p.reversedGross)} that PayPal took back` : "") +
    (parts.pool < 0 ? `. The fund is below zero because some of that money was already spent, so no new cat is funded until donations cover it` : "");
  return { text, balanced, parts };
}

export type BarPart = { key: "vets" | "aside" | "free" | "fees"; label: string; amount: number };

/**
 * The same figures as the sentence, in four groups for a bar. Fees are PayPal's and the payout fees together.
 * Null when a part is below zero or nothing came in, because a bar cannot show that and the sentence says why.
 * When it is not null the amounts add up to the donated total exactly.
 */
export function barParts(c: Conservation): BarPart[] | null {
  const { donated, paypalFees, payoutFees, paidToVets, held, pool } = c.parts;
  const parts: BarPart[] = [
    { key: "vets", label: "Paid to vets", amount: paidToVets },
    { key: "aside", label: "Set aside for cats", amount: held },
    { key: "free", label: "Still free", amount: pool },
    { key: "fees", label: "Fees", amount: paypalFees + payoutFees },
  ];
  if (donated <= 0 || parts.some((p) => p.amount < 0)) return null;
  return c.balanced ? parts : null;
}

const TYPE_LABEL: Record<string, string> = {
  donation: "Donation",
  refund: "Refund",
  vet_deposit: "First payment",
  vet_balance: "Final payment",
};

const LEDGER_STATUS_LABEL: Record<string, string> = {
  captured: "Received",
  refunded: "Refunded",
  reversed: "Taken back by PayPal",
  denied: "Taken back by PayPal",
  succeeded: "Paid",
  failed: "Failed",
  queued: "Sending",
  sent: "Sending",
  awaiting_approval: "Waiting for approval",
  needs_review: "Being checked",
  rejected: "Refused",
};

export const typeLabel = (type: string) => TYPE_LABEL[type] ?? "Payment";
export const ledgerStatusLabel = (status: string) => LEDGER_STATUS_LABEL[status] ?? "Recorded";
/** Failed and refused rows are styled as problems, always with their words as well. */
export const isProblemStatus = (status: string) => status === "failed" || status === "rejected";

/** Centavos as a plain decimal for a CSV cell, e.g. 150050 -> "1500.50". */
export const csvPesos = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** Stops a spreadsheet from running text that begins like a formula. */
export function csvSafe(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
