import type { Metadata } from "next";
import { Suspense } from "react";
import { getSession } from "@/server/session";
import { DonateForm } from "@/components/DonateForm";

export const metadata: Metadata = { title: "Donate | Stray Fund" };

async function Form() {
  const session = await getSession();
  // The client id is public by design. Read here on the server so no NEXT_PUBLIC variable is needed.
  const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
  return <DonateForm clientId={clientId} username={session?.username ?? null} />;
}

export default function DonatePage() {
  return (
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">Fund the next neuter.</h1>
      <p className="mt-4 max-w-[36ch]">
        Donations go into one shared fund that pays vets to neuter the colony&apos;s stray cats.
      </p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Form />
      </Suspense>
    </main>
  );
}
