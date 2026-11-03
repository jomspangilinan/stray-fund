import type { Metadata } from "next";
import { Suspense } from "react";
import { getSession } from "@/server/session";
import { BlockSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { SpotFlow } from "@/components/SpotFlow";

export const metadata: Metadata = { title: "Spot a cat | Stray Fund" };

async function Flow() {
  const session = await getSession();
  return <SpotFlow username={session?.username ?? null} />;
}

export default function SpotPage() {
  return (
    <main className="play">
      <PageHead title="Spot a cat" />
      <Suspense fallback={<BlockSkeleton label="Loading the camera" />}>
        <Flow />
      </Suspense>
    </main>
  );
}
