import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { CatList } from "@/components/desk/CatList";
import { DeskGate } from "@/components/desk/DeskGate";
import { DeskNav } from "@/components/desk/DeskNav";
import { getCaretakerQueue } from "@/server/caretaker/queue";

export const metadata: Metadata = { title: "Cats | Stray Fund" };

async function Cats() {
  await connection();
  const q = await getCaretakerQueue();
  return <CatList cats={q.catChoices} />;
}

export default function CaretakerCatsPage() {
  return (
    <main>
      <PageHead title="Cats">Sex, flags and the last steps to a home.</PageHead>
      <DeskNav current="/caretaker/cats" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <DeskGate>
          <Cats />
        </DeskGate>
      </Suspense>
    </main>
  );
}
