import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { AgentFeed } from "@/components/AgentFeed";
import { listAgentActions } from "@/server/public";

export const metadata: Metadata = { title: "Treasurer | Stray Fund" };

async function Feed() {
  await connection();
  return <AgentFeed initial={await listAgentActions()} />;
}

export default function AgentPage() {
  return (
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">The treasurer.</h1>
      <p className="mt-4 max-w-[40ch]">
        An AI decides which cat is helped next and pays the vet. Fixed rules in our code can refuse it, and a person
        checks anything unclear. Every decision is written here.
      </p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Feed />
      </Suspense>
    </main>
  );
}
