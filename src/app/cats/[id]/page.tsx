import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { CatDetail } from "@/components/CatDetail";
import { BlockSkeleton } from "@/components/Loading";
import { nameControls } from "@/server/catNames";
import { db } from "@/server/db/client";
import { ownFlags } from "@/server/earTipFlags";
import { getCatCard, SEX_LABEL } from "@/server/public";
import { getSession } from "@/server/session";
import { catTimeline } from "@/server/timeline";
import { getCatThanks } from "@/server/thanks";

export const metadata: Metadata = { title: "Cat | Stray Fund" };

async function Card({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const card = await getCatCard(id);
  if (!card) notFound();
  const timeline = await catTimeline(card.cat.id, card.cat.journey);
  const session = await getSession();
  const mine = session ? (await ownFlags(db, session.userId, [card.cat.id])).get(card.cat.id) : undefined;
  const names = session ? await nameControls(card.cat.id, session.userId) : undefined;
  return <CatDetail card={card} thanks={await getCatThanks(card.cat.id)} earTip={session ? (mine ?? "unsure") : undefined} names={names} askSex={session !== null && card.cat.sex === SEX_LABEL.unknown} caretaker={session?.role === "caretaker"} timeline={timeline} />;
}

export default function CatPage({ params }: PageProps<"/cats/[id]">) {
  return (
    <main className="play pt-2">
      <Suspense fallback={<BlockSkeleton label="Loading the cat" />}>
        <Card params={params} />
      </Suspense>
    </main>
  );
}
