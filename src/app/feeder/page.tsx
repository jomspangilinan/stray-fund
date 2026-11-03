import type { Metadata } from "next";
import { Suspense } from "react";
import { getSession } from "@/server/session";
import { FeederMode } from "@/components/FeederMode";
import { BlockSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = { title: "Feeder camera | Stray Fund" };

async function Watch() {
  const session = await getSession();
  return <FeederMode username={session?.username ?? null} />;
}

export default function FeederPage() {
  return (
    <main>
      <PageHead title="Feeder watch">
        Prop this phone by the feeder. When something moves, it takes a photo and sends it in.
      </PageHead>
      <Suspense fallback={<BlockSkeleton label="Loading the camera" />}>
        <Watch />
      </Suspense>
    </main>
  );
}
