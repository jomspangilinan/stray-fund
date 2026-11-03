import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { AgentFeed } from "@/components/AgentFeed";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { listAgentActions } from "@/server/public";

export const metadata: Metadata = { title: "Treasurer | Stray Fund" };

async function Feed() {
  await connection();
  return <AgentFeed initial={await listAgentActions()} />;
}

export default function AgentPage() {
  return (
    <main>
      <PageHead title="Treasurer">
        An AI picks the next cat. Rules can refuse it, and a person checks anything unclear.
      </PageHead>
      <Suspense fallback={<ListSkeleton rows={3} label="Loading decisions" />}>
        <Feed />
      </Suspense>
    </main>
  );
}
