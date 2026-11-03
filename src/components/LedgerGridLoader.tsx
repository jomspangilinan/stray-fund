"use client";

import dynamic from "next/dynamic";
import type { PublicLedgerRow } from "@/server/public";

/** Loads the grid library only on the ledger, so no other page carries its weight. */
const LedgerGrid = dynamic(() => import("./LedgerGrid").then((m) => m.LedgerGrid), {
  ssr: false,
  loading: () => (
    <div className="mt-5" role="status" aria-label="Loading the ledger">
      <span className="skeleton block h-12 w-full" aria-hidden="true" />
      <span className="skeleton mt-2 block h-[26rem] w-full !rounded-out" aria-hidden="true" />
      <span className="sr-only">Loading the ledger</span>
    </div>
  ),
});

export function LedgerGridLoader({ initial }: { initial: PublicLedgerRow[] }) {
  return <LedgerGrid initial={initial} />;
}
