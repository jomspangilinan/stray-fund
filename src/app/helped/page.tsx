import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CatRow } from "@/components/CatRow";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { SignIn } from "@/components/SignIn";
import { formatPeso } from "@/lib/money";
import { CelebrationNote } from "@/components/CelebrationNote";
import { celebrationText, findCelebration, milestoneLabel } from "@/server/milestones";
import { getHelpedEntries, getUnallocated } from "@/server/public";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "Cats I've helped | Stray Fund" };

async function Helped() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="card mt-6">
        <p className="mb-4 font-bold">Sign in to see the cats you have helped.</p>
        <SignIn username={null} inline />
      </div>
    );
  }
  const [entries, unallocated] = await Promise.all([
    getHelpedEntries(session.userId),
    getUnallocated(session.userId),
  ]);
  // One moment at a time, and only for a cat this donor helped. The browser marks it seen after showing it.
  const celebration = await findCelebration(session.userId, entries);
  return (
    <>
      {celebration && (
        <CelebrationNote text={celebrationText(celebration)} catId={celebration.catId} milestone={celebration.milestone} />
      )}
      {unallocated > 0 && (
        <p className="note note-ok mt-6">
          <strong>Your donation is waiting in the pool.</strong> {formatPeso(unallocated)} has not been matched to a
          cat yet. It will show up here when it is.
        </p>
      )}
      {entries.length === 0 ? (
        <div className="card mt-6">
          <p className="font-bold">You have not helped a cat yet.</p>
          <p className="mt-1 soft">Once a donation of yours goes to a cat, the cat shows up here.</p>
          <Link href="/donate" className="btn-pop mt-4">
            Donate to help a cat
          </Link>
        </div>
      ) : (
        <ul className="list mt-6">
          {entries.map((e) => (
            <CatRow
              key={e.cat.id}
              cat={e.cat}
              footer={
                <p className="small">
                  {milestoneLabel(e.cat)}. You put <strong>{formatPeso(e.amount)}</strong> toward {e.cat.name}.
                </p>
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
    <main>
      <PageHead title="Cats I've helped">The cats your donations have gone to.</PageHead>
      <Suspense fallback={<ListSkeleton rows={3} label="Loading your cats" />}>
        <Helped />
      </Suspense>
    </main>
  );
}
