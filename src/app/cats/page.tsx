import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CatCard } from "@/components/CatCard";
import { listCats, STATUS_GROUPS, STATUS_GROUP_LABEL, type StatusGroup } from "@/server/public";

export const metadata: Metadata = { title: "Cats | Stray Fund" };

const GROUPS = Object.keys(STATUS_GROUPS) as StatusGroup[];

async function Grid({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  await connection();
  const { status } = await searchParams;
  const group = typeof status === "string" && status in STATUS_GROUPS ? (status as StatusGroup) : "all";
  const cats = await listCats(group);
  return (
    <>
      <nav aria-label="Filter cats" className="mt-6 flex flex-wrap gap-2">
        {(["all", ...GROUPS] as const).map((g) => (
          <Link
            key={g}
            href={g === "all" ? "/cats" : `/cats?status=${g}`}
            aria-current={g === group ? "page" : undefined}
            className={`border-2 border-ink px-3 py-1 text-sm font-bold ${g === group ? "bg-sign" : "bg-paper"}`}
          >
            {g === "all" ? "All" : STATUS_GROUP_LABEL[g]}
          </Link>
        ))}
      </nav>
      {cats.length === 0 ? (
        <p className="note mt-8">No cats here yet. Spot one from the Catch page.</p>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-5 min-[480px]:grid-cols-2">
          {cats.map((c) => (
            <CatCard key={c.id} cat={c} />
          ))}
        </ul>
      )}
    </>
  );
}

export default function CatsPage({ searchParams }: PageProps<"/cats">) {
  return (
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">The colony.</h1>
      <p className="mt-4 max-w-[40ch]">
        Every stray we know by name. Exact spots stay private to protect the cats.
      </p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Grid searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
