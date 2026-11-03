import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CatTile } from "@/components/CatTile";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { PageSwitch } from "@/components/PageSwitch";
import { HELPED_PAGES } from "@/lib/nav";
import { SignInGate } from "@/components/SignInGate";
import { isDemoMode } from "@/lib/config";
import { formatPeso } from "@/lib/money";
import { CelebrationNote } from "@/components/CelebrationNote";
import { streakLabel } from "@/lib/streak";
import { getStreak } from "@/server/streak";
import { getBadgesFor } from "@/server/thanks";
import { celebrationText, findCelebration } from "@/server/milestones";
import { getHelpedEntries, getUnallocated } from "@/server/public";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "Cats I've helped | Stray Fund" };

async function Helped() {
  const session = await getSession();
  if (!session) {
    return (
      <SignInGate demo={isDemoMode()}>
        <p className="font-bold">The cats you have helped show up here.</p>
        <p className="soft">Each one comes with what you gave, plus your streak and badges.</p>
      </SignInGate>
    );
  }
  const [entries, unallocated] = await Promise.all([
    getHelpedEntries(session.userId),
    getUnallocated(session.userId),
  ]);
  // One moment at a time, and only for a cat this donor helped. The browser marks it seen after showing it.
  const celebration = await findCelebration(session.userId, entries);
  const streak = streakLabel(await getStreak(session.userId));
  const badges = await getBadgesFor(session.userId);
  return (
    <>
      {streak && <p className="mt-4 font-bold text-main">{streak}</p>}
      {badges.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Your badges">
          {badges.map((b) => (
            <li key={b} className="tag">
              {b}
            </li>
          ))}
        </ul>
      )}
      {celebration && (
        <CelebrationNote text={celebrationText(celebration)} catId={celebration.catId} milestone={celebration.milestone} />
      )}
      {unallocated > 0 && (
        <p className="note note-ok mt-6">
          <strong>Your gift is in the shared fund.</strong> It reaches a cat soon.
        </p>
      )}
      {entries.length === 0 ? (
        <div className="card mt-6">
          <p className="font-bold">Your first cat shows up here.</p>
          <Link href="/donate" className="btn-pop mt-4">
            Help a cat
          </Link>
        </div>
      ) : (
        <ul className="tiles mt-6">
          {entries.map((e) => (
            <CatTile
              key={e.cat.id}
              cat={e.cat}
              line={
                <>
                  You gave <strong>{formatPeso(e.amount)}</strong>
                </>
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

export default function HelpedPage() {
  return (
    <main className="play">
      <PageSwitch label="Helped" pages={HELPED_PAGES} current="/helped" />
      <PageHead title="Cats I've helped" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading your cats" />}>
        <Helped />
      </Suspense>
    </main>
  );
}
