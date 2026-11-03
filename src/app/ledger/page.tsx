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
      <PageHead title="Ledger">Every donation and vet payout. Test money.</PageHead>
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        <Link href="/impact" className="link">
          Proof it adds up
        </Link>
        <Link href="/agent" className="link">
          Treasurer decisions
        </Link>
      </p>
      <Suspense fallback={<ListSkeleton rows={4} label="Loading the ledger" />}>
        <Ledger />
      </Suspense>
    </main>
  );
}
