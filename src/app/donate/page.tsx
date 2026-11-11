import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { isDemoMode, moneyIsTest } from "@/lib/config";
import { getSession } from "@/server/session";
import { DonateForm } from "@/components/DonateForm";
import { BlockSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = { title: "Donate | Stray Fund" };

async function Form() {
  const session = await getSession();
  // The client id is public by design. Read here on the server so no NEXT_PUBLIC variable is needed.
  const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
  return <DonateForm clientId={clientId} username={session?.username ?? null} demo={isDemoMode()} testMoney={moneyIsTest()} />;
}

export default function DonatePage() {
  return (
    <main>
      <PageHead title="Donate">
        <Link href="/impact" className="link !inline !min-h-0">
          Where it goes
        </Link>
      </PageHead>
      <Suspense fallback={<BlockSkeleton label="Loading the donation form" />}>
        <Form />
      </Suspense>
    </main>
  );
}
