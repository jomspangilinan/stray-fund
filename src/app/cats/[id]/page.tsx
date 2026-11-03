import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { CatDetail } from "@/components/CatDetail";
import { getCatCard } from "@/server/public";

export const metadata: Metadata = { title: "Cat | Stray Fund" };

async function Card({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const card = await getCatCard(id);
  if (!card) notFound();
  return <CatDetail card={card} />;
}

export default function CatPage({ params }: PageProps<"/cats/[id]">) {
  return (
    <main className="pt-4">
      <Suspense fallback={<p className="text-dusk">Loading</p>}>
        <Card params={params} />
      </Suspense>
    </main>
  );
}
