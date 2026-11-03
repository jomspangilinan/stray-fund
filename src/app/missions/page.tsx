import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { GoalCard } from "@/components/GoalCard";
import { ListSkeleton } from "@/components/Loading";
import { MissionList } from "@/components/MissionList";
import { PageHead } from "@/components/PageHead";
import { COLONY } from "@/lib/config";
import { getGoalProgress, getMissions } from "@/server/public";

export const metadata: Metadata = { title: "Missions | Stray Fund" };

async function Missions() {
  await connection();
  const [goal, missions] = await Promise.all([getGoalProgress(), getMissions()]);
  return (
    <>
      <div className="mt-4">
        <GoalCard goal={goal} />
      </div>
      <h2 className="h2 mt-8">{COLONY.area_name}</h2>
      {missions.length === 0 ? (
        <div className="card mt-3">
          <p className="font-bold">No missions right now</p>
          <Link href="/spot" className="btn mt-4">
            Spot a cat
          </Link>
        </div>
      ) : (
        <>
          <p className="small soft mt-1">Picked from who needs help most.</p>
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
      <Suspense fallback={<ListSkeleton rows={3} label="Loading missions" />}>
        <Missions />
      </Suspense>
    </main>
  );
}
