import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CatRow } from "@/components/CatRow";
import { BlockSkeleton } from "@/components/Loading";
import { StatusFilter } from "@/components/StatusFilter";
import { formatPesoShort } from "@/lib/money";
import { getHomeData } from "@/server/public";

async function Home() {
  await connection();
  const { poolAvailable, latestAction, cats, catCount } = await getHomeData();
  return (
    <>
      <section aria-labelledby="pool-title" className="on-main mt-2 rounded-out bg-main p-5 text-white">
        <h2 id="pool-title" className="sr-only">
          The pool
        </h2>
        <p className="balance">
          {formatPesoShort(poolAvailable)}
        </p>
        <p className="mt-1.5 text-base font-semibold">
          {poolAvailable > 0 ? "ready for the next cat" : "in the pool. The next donation funds the next cat."}
        </p>
        <Link href="/donate" className="btn-pop mt-5 w-full sm:w-auto">
          Donate
        </Link>
      </section>

      <section className="mt-8" aria-labelledby="latest-title">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="latest-title" className="h2">
            Treasurer&apos;s latest
          </h2>
          <Link href="/agent" className="link">
            All decisions
          </Link>
        </div>
        {latestAction ? (
          <div className="card mt-2">
            <p>
              <strong>{latestAction.cat ? `${latestAction.action}: ${latestAction.cat}.` : `${latestAction.action}.`}</strong>{" "}
              {latestAction.reason}
            </p>
            <p className="small soft mt-2">
              {latestAction.amount !== null ? `${formatPesoShort(latestAction.amount)}, ` : ""}
              {latestAction.status}, {latestAction.date}
              {" "}
              <Link href={`/agent#a-${latestAction.id}`} className="font-bold text-main underline underline-offset-4">
                Why
              </Link>
            </p>
          </div>
        ) : (
          <p className="note mt-2">Nothing yet. The treasurer posts here as soon as money moves.</p>
        )}
      </section>

      <section className="mt-8" aria-labelledby="cats-title">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="cats-title" className="h2">
            Our cats
          </h2>
          {catCount > 0 && (
            <Link href="/cats" className="link">
              See all {catCount}
            </Link>
          )}
        </div>
        <div className="mt-2">
          <StatusFilter current={null} />
        </div>
        {cats.length === 0 ? (
          <div className="card mt-3">
            <p className="font-bold">No cats yet.</p>
            <p className="mt-1 soft">Spot one with the camera and it gets a card here.</p>
            <Link href="/spot" className="btn mt-4">
              Spot a cat
            </Link>
          </div>
        ) : (
          <ul className="list mt-3">
            {cats.map((c) => (
              <CatRow key={c.id} cat={c} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function HomePage() {
  return (
    <main>
      <Suspense fallback={<BlockSkeleton label="Loading the pool" />}>
        <Home />
      </Suspense>
    </main>
  );
}
