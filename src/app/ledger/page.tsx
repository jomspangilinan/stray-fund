import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { LedgerGridLoader } from "@/components/LedgerGridLoader";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { getLedger } from "@/server/impact";

export const metadata: Metadata = { title: "Ledger | Stray Fund" };

async function Ledger() {
  await connection();
  return <LedgerGridLoader initial={await getLedger()} />;
}

export default function LedgerPage() {
  return (
    <main>
      <PageHead title="Ledger">
        Every donation in and every payout to a vet, with the reason and the PayPal sandbox reference. Search, sort or
        filter it, and download it as a spreadsheet.
      </PageHead>
      <Link href="/impact" className="link">
        How the money adds up
      </Link>
      <Suspense fallback={<ListSkeleton rows={4} label="Loading the ledger" />}>
        <Ledger />
      </Suspense>
    </main>
  );
}
