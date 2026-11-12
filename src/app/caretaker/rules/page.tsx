import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { DeskGate } from "@/components/desk/DeskGate";
import { Rules } from "@/components/desk/RulesView";
import { getRulesView } from "@/server/caretaker/queue";

export const metadata: Metadata = { title: "Rules | Stray Fund" };

async function RulesBody() {
  await connection();
  return <Rules rules={await getRulesView()} />;
}

export default function CaretakerRulesPage() {
  return (
    <main>
      <PageHead title="Rules" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <DeskGate>
          <RulesBody />
        </DeskGate>
      </Suspense>
    </main>
  );
}
