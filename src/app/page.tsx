import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { BlockSkeleton } from "@/components/Loading";
import { formatPesoShort } from "@/lib/money";
import { HomeYou } from "@/components/HomeYou";
import { CatTile } from "@/components/CatTile";
import { HeroGoal } from "@/components/HeroGoal";
import { getGoalProgress, getHomeData } from "@/server/public";

async function Home() {
  await connection();
  const [{ poolAvailable, latestAction, cats, catCount }, goal] = await Promise.all([getHomeData(), getGoalProgress()]);
  return (
    <>
      <HeroGoal goal={goal} cats={cats} />
      <section aria-labelledby="pool-title" className="on-main mt-3 rounded-out bg-main p-5 text-white">
        <h2 id="pool-title" className="sr-only">
          The fund
        </h2>
        <p className="balance">
          {formatPesoShort(poolAvailable)}
        </p>
        <p className="mt-1.5 text-base font-semibold">
          {poolAvailable > 0 ? "ready for the next cat" : "in the fund"}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-1">
          <Link href="/donate" className="btn-pop w-full sm:w-auto">
            Donate
          </Link>
          <Link href="/impact" className="link !text-white underline">
            How the money adds up
          </Link>
        </div>
      </section>

      <Suspense fallback={null}>
        <HomeYou />
      </Suspense>

      {latestAction && (
      <section className="mt-8" aria-labelledby="latest-title">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="latest-title" className="h2">
            Latest decision
          </h2>
          <Link href="/agent" className="link">
            All decisions
          </Link>
        </div>
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
      </section>
      )}

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
        {cats.length === 0 ? (
          <div className="card mt-3">
            <p className="font-bold">No cats yet.</p>
            <Link href="/spot" className="btn mt-4">
              Spot a cat
            </Link>
          </div>
        ) : (
          <ul className="tiles mt-3">
            {cats.slice(0, 4).map((c) => (
              <CatTile key={c.id} cat={c} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function HomePage() {
  return (
    <main className="play">
      <Suspense fallback={<BlockSkeleton label="Loading the fund" />}>
        <Home />
      </Suspense>
    </main>
  );
}
