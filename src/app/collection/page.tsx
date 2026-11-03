import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CatCard } from "@/components/CatCard";
import { SignIn } from "@/components/SignIn";
import { formatPeso } from "@/lib/money";
import { getCollectionEntries, getUnallocated } from "@/server/public";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "My collection | Stray Fund" };

async function Collection() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="ticket mt-8">
        <p className="mb-4 font-bold">Sign in to see the cats you have helped.</p>
        <SignIn username={null} inline />
      </div>
    );
  }
  const [entries, unallocated] = await Promise.all([
    getCollectionEntries(session.userId),
    getUnallocated(session.userId),
  ]);
  return (
    <>
      {unallocated > 0 && (
        <p className="note note-ok mt-8">
          <strong>Your donation is waiting in the pool.</strong> {formatPeso(unallocated)} has not been matched to a
          cat yet. It will show up here when it is.
        </p>
      )}
      {entries.length === 0 ? (
        <div className="mt-8">
          <p>You have not helped a cat yet.</p>
          <Link href="/donate" className="btn mt-4 inline-flex items-center">
            Donate to start your collection
          </Link>
        </div>
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-5 min-[480px]:grid-cols-2">
          {entries.map((e) => (
            <CatCard
              key={e.cat.id}
              cat={e.cat}
              footer={
                <p className="text-sm">
                  Your donations put <strong>{formatPeso(e.amount)}</strong> toward {e.cat.name}.
                </p>
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

export default function CollectionPage() {
  return (
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">My collection.</h1>
      <p className="mt-4 max-w-[40ch]">The cats your donations have gone to.</p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Collection />
      </Suspense>
    </main>
  );
}
