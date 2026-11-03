import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CatRow } from "@/components/CatRow";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { StatusFilter } from "@/components/StatusFilter";
import { listCats, STATUS_GROUPS, type StatusGroup } from "@/server/public";

export const metadata: Metadata = { title: "Cats | Stray Fund" };

async function Grid({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  await connection();
  const { status } = await searchParams;
  const group = typeof status === "string" && status in STATUS_GROUPS ? (status as StatusGroup) : "all";
  const cats = await listCats(group);
  return (
    <>
      <Link href="/missions" className="btn-quiet mt-4 w-full">
        Missions: help a cat
      </Link>
      <div className="mt-3">
        <StatusFilter current={group} />
      </div>
      {cats.length === 0 ? (
        <div className="card mt-4">
          <p className="font-bold">No cats here yet.</p>
          <p className="mt-1 soft">
            {group === "all" ? "Spot one and it gets a card." : "Nothing is at this stage right now."}
          </p>
          <Link href={group === "all" ? "/spot" : "/cats"} className="btn mt-4">
            {group === "all" ? "Spot a cat" : "See all cats"}
          </Link>
        </div>
      ) : (
        <ul className="list mt-4">
          {cats.map((c) => (
            <CatRow key={c.id} cat={c} />
          ))}
        </ul>
      )}
    </>
  );
}

export default function CatsPage({ searchParams }: PageProps<"/cats">) {
  return (
    <main>
      <PageHead title="Cats">Every stray we know by name. Exact spots stay private to protect the cats.</PageHead>
      <Suspense fallback={<ListSkeleton label="Loading the cats" />}>
        <Grid searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
