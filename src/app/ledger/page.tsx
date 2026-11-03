import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = { title: "Ledger | Stray Fund" };

/** A stand-in so the Ledger tab never dead-ends. A later task replaces this page. */
export default function LedgerPage() {
  return (
    <main>
      <PageHead title="Ledger" />
      <div className="card mt-5">
        <p className="font-bold">The ledger is coming.</p>
        <p className="mt-1 soft">
          Every peso in and out of the fund will be listed here. Until then, the treasurer page shows each decision as
          it happens.
        </p>
        <Link href="/agent" className="btn mt-4">
          See the treasurer
        </Link>
      </div>
    </main>
  );
}
