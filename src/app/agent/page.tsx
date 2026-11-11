import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { AgentFeed } from "@/components/AgentFeed";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { PageSwitch } from "@/components/PageSwitch";
import { TREASURER_INTRO } from "@/lib/feedCopy";
import { FUND_PAGES } from "@/lib/nav";
import { listAgentActions } from "@/server/public";

export const metadata: Metadata = { title: "Treasurer | Stray Fund" };

async function Feed() {
  await connection();
  return <AgentFeed initial={await listAgentActions()} />;
}

export default function AgentPage() {
  return (
    <main>
      <PageHead title="Treasurer" action={{ href: "/donate", label: "Donate" }}>
        {TREASURER_INTRO}
      </PageHead>
      <PageSwitch label="Fund" pages={FUND_PAGES} current="/agent" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading decisions" />}>
        <Feed />
      </Suspense>
    </main>
  );
}
