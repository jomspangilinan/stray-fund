import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { formatPesoShort } from "@/lib/money";
import { DeskWaiting } from "@/components/DeskWaiting";
import { HomeYou } from "@/components/HomeYou";
import { CatPhoto } from "@/components/CatPhoto";
import { Yard, YardSkeleton } from "@/components/Yard";
import { getHomeData, getMissions, getYard } from "@/server/public";
import { getSession } from "@/server/session";

async function Home() {
  await connection();
  const session = await getSession();
  const viewerId = session?.userId ?? null;
  const [{ poolAvailable, latestAction }, yard, missions] = await Promise.all([
    getHomeData(),
    getYard(viewerId),
    getMissions(new Date(), viewerId),
  ]);
  const mission = missions[0];
  return (
    <>
      <Suspense fallback={null}>
        <DeskWaiting />
      </Suspense>
      <Yard yard={yard} />

      <section aria-label="The fund" className="yard-row">
        <div>
          <p className="yard-fund">{formatPesoShort(poolAvailable)}</p>
          <p className="small soft">{poolAvailable > 0 ? "ready for the next cat" : "in the fund"}</p>
        </div>
        <Link href="/donate" className="btn-pop flex-none">
          Donate
        </Link>
      </section>

      {mission && (
        <section aria-label="A mission" className="yard-row !pl-3">
          <Link href={`/cats/${mission.catId}`} className="relative h-14 w-14 flex-none overflow-hidden rounded-in" aria-hidden="true" tabIndex={-1}>
            <CatPhoto url={mission.photoUrl} name={mission.title} sizes="56px" />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="font-bold leading-tight">{mission.title}</p>
            <Link href="/missions" className="small link !min-h-0">
              All missions
            </Link>
          </div>
          <Link href={mission.action === "spot" ? "/spot" : `/cats/${mission.catId}`} className="btn flex-none !min-h-11">
            {mission.action === "spot" ? "Spot" : "Open"}
          </Link>
        </section>
      )}

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

      <p className="mt-6">
        <Link href="/impact" className="link">
          How the money adds up
        </Link>
      </p>
    </>
  );
}

export default function HomePage() {
  return (
    <main className="play">
      <Suspense fallback={<YardSkeleton />}>
        <Home />
      </Suspense>
    </main>
  );
}
