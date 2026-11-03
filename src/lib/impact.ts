import { formatPeso } from "./money";
import type { PoolStatus } from "@/server/ledger";
import type { PublicLedgerRow } from "@/server/public";

/** Payout states where the money is committed but no vet has been paid yet. Mirrors getPoolStatus. */
export const IN_FLIGHT = ["awaiting_approval", "queued", "sent", "needs_review"] as const;

export const isDonationRow = (r: Pick<PublicLedgerRow, "type">) => r.type === "donation";

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

/** Donated = PayPal fees + paid to vets + payout fees + held for cats (in-flight included) + left in the pool. */
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
    ` + held for cats ${formatPeso(parts.held)} + left in the pool ${formatPeso(parts.pool)}`;
  return { text, balanced, parts };
}

const TYPE_LABEL: Record<string, string> = {
  donation: "Donation",
  vet_deposit: "Vet deposit",
  vet_balance: "Vet balance",
};

const LEDGER_STATUS_LABEL: Record<string, string> = {
  captured: "Received",
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
