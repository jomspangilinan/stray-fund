import type { Metadata } from "next";
import { Suspense } from "react";
import { getSession } from "@/server/session";
import { CatchFlow } from "@/components/CatchFlow";

export const metadata: Metadata = { title: "Catch a cat | Stray Fund" };

async function Flow() {
  const session = await getSession();
  return <CatchFlow username={session?.username ?? null} />;
}

export default function CatchPage() {
  return (
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">Spot a stray.</h1>
      <p className="mt-4 max-w-[36ch]">
        Take a photo of a cat you see around the neighbourhood. We start a card, or add to one we already have.
      </p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Flow />
      </Suspense>
    </main>
  );
}
