import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { GoalCard } from "@/components/GoalCard";
import { ListSkeleton } from "@/components/Loading";
import { MissionList } from "@/components/MissionList";
import { PageHead } from "@/components/PageHead";
import { PageSwitch } from "@/components/PageSwitch";
import { HELPED_PAGES } from "@/lib/nav";
import { getGoalProgress, getMissions } from "@/server/public";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "Missions | Stray Fund" };

async function Missions() {
  await connection();
  const session = await getSession();
  const [goal, missions] = await Promise.all([getGoalProgress(), getMissions(new Date(), session?.userId ?? null)]);
  return (
    <>
      <div className="mt-4">
        <GoalCard goal={goal} />
      </div>
      {missions.length === 0 ? (
        <div className="card mt-6">
          <p className="font-bold">No missions right now</p>
          <Link href="/spot" className="btn mt-4">
            Spot a cat
          </Link>
        </div>
      ) : (
        <>
          <h2 className="h2 mt-8">Where you can help</h2>
          <div className="mt-3">
            <MissionList missions={missions} />
          </div>
        </>
      )}
    </>
  );
}

export default function MissionsPage() {
  return (
    <main className="play">
      <PageHead title="Missions" />
      <PageSwitch label="Helped" pages={HELPED_PAGES} current="/missions" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading missions" />}>
        <Missions />
      </Suspense>
    </main>
  );
}
