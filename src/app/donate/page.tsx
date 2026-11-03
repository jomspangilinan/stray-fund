import type { Metadata } from "next";
import { Suspense } from "react";
import { getSession } from "@/server/session";
import { DonateForm } from "@/components/DonateForm";
import { BlockSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = { title: "Donate | Stray Fund" };

async function Form() {
  const session = await getSession();
  // The client id is public by design. Read here on the server so no NEXT_PUBLIC variable is needed.
  const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
  return <DonateForm clientId={clientId} username={session?.username ?? null} />;
}

export default function DonatePage() {
  return (
    <main>
      <PageHead title="Donate">
        Donations go into one shared fund that pays vets to neuter the colony&apos;s stray cats.
      </PageHead>
      <Suspense fallback={<BlockSkeleton label="Loading the donation form" />}>
        <Form />
      </Suspense>
    </main>
  );
}
