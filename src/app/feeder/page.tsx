import type { Metadata } from "next";
import { Suspense } from "react";
import { getSession } from "@/server/session";
import { FeederMode } from "@/components/FeederMode";

export const metadata: Metadata = { title: "Feeder camera | Stray Fund" };

async function Watch() {
  const session = await getSession();
  return <FeederMode username={session?.username ?? null} />;
}

export default function FeederPage() {
  return (
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">Feeder watch.</h1>
      <p className="mt-4 max-w-[36ch]">
        Prop this phone by the feeder. When something moves, it takes a photo and sends it in.
      </p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Watch />
      </Suspense>
    </main>
  );
}
