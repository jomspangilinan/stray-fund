import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { PageSwitch } from "@/components/PageSwitch";
import { PriorityList } from "@/components/PriorityList";
import { FUND_PAGES } from "@/lib/nav";
import { getPriorityList } from "@/server/public";

export const metadata: Metadata = { title: "Priority | Stray Fund" };

async function List() {
  await connection();
  return <PriorityList initial={await getPriorityList()} />;
}

export default function PriorityPage() {
  return (
    <main>
      <PageSwitch label="Fund" pages={FUND_PAGES} current="/priority" action={{ href: "/donate", label: "Donate" }} />
      <PageHead title="Priority">What the Treasurer is doing for each cat.</PageHead>
      <Suspense fallback={<ListSkeleton rows={3} label="Loading the priority list" />}>
        <List />
      </Suspense>
    </main>
  );
}
