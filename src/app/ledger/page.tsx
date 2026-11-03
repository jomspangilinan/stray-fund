import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { LedgerGridLoader } from "@/components/LedgerGridLoader";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { PageSwitch } from "@/components/PageSwitch";
import { FUND_PAGES } from "@/lib/nav";
import { moneyIsTest } from "@/lib/config";
import { testMoneyLine } from "@/lib/moneyCopy";
import { getLedger } from "@/server/impact";

export const metadata: Metadata = { title: "Ledger | Stray Fund" };

async function Ledger() {
  await connection();
  const initial = await getLedger();
  return (
    <>
      {moneyIsTest() && <p className="note mb-3">{testMoneyLine(true)}</p>}
      <LedgerGridLoader initial={initial} />
    </>
  );
}

export default function LedgerPage() {
  return (
    <main>
      <PageSwitch label="Fund" pages={FUND_PAGES} current="/ledger" action={{ href: "/donate", label: "Donate" }} />
      <PageHead title="Ledger">Every donation and vet payout.</PageHead>
      <Suspense fallback={<ListSkeleton rows={4} label="Loading the ledger" />}>
        <Ledger />
      </Suspense>
    </main>
  );
}
