import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { CatPhoto } from "@/components/CatPhoto";
import { CatTimeline } from "@/components/CatTimeline";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { RotateButtons } from "@/components/SightingPhoto";
import { CatBrowser } from "@/components/desk/CatBrowser";
import { CatRemove } from "@/components/desk/CatList";
import { CatMerge } from "@/components/desk/CatMerge";
import { CatProfileForm } from "@/components/desk/CatProfileForm";
import { DeskGate } from "@/components/desk/DeskGate";
import { PhotoZoom } from "@/components/desk/PhotoZoom";
import { getCaretakerQueue, type CaretakerQueue } from "@/server/caretaker/queue";
import { db } from "@/server/db/client";
import { cats, reports } from "@/server/db/schema";
import { getCatCard, isUuid, listCats } from "@/server/public";
import { catTimeline } from "@/server/timeline";

export const metadata: Metadata = { title: "Cats | Stray Fund" };

/** One cat's profile: photo, then everything a caretaker can change with one Save, then what happened. */
async function Profile({ c }: { c: CaretakerQueue["catChoices"][number] }) {
  const [[cat], catReports, card] = await Promise.all([
    db.select({ status: cats.status, earTipped: cats.earTipped, unconfirmed: cats.neuteredUnconfirmed }).from(cats).where(eq(cats.id, c.id)),
    db.select({ id: reports.id, claim: reports.claim, status: reports.status }).from(reports).where(eq(reports.catId, c.id)),
    getCatCard(c.id),
  ]);
  if (!cat) return <p>This cat is gone.</p>;
  const timeline = card ? await catTimeline(c.id, card.cat.journey) : [];
  const photo = card?.cat.photoUrl ?? null;
  // The sighting whose public copy is the photo above, so a sideways one can be turned from here.
  const photoSightingId = photo ? (card?.sightings.find((s) => s.photoUrl === photo)?.id ?? null) : null;
  const statusLabel = card?.cat.statusLabel ?? c.status;
  // Only a cat Remove would take can be merged, so only then are the other cats loaded for the picker.
  const mergeable = cat.status === "spotted" && c.plainOnly;
  const others = mergeable ? (await listCats()).filter((o) => o.id !== c.id).map((o) => ({ id: o.id, name: o.name, photoUrl: o.photoUrl })) : [];

  return (
    <>
      <div className="flex items-center gap-4">
        <div className="relative h-24 w-24 flex-none overflow-hidden rounded-in">
          <PhotoZoom url={photo} name={c.name}>
            <CatPhoto url={photo} name={c.name} sizes="96px" />
          </PhotoZoom>
        </div>
        <div className="min-w-0">
          <h2 className="text-xl font-extrabold break-words">{c.name}</h2>
          <p className="small">{statusLabel}</p>
          {card?.cat.area && <p className="small soft">{card.cat.area}</p>}
        </div>
      </div>
      {photoSightingId && <RotateButtons sightingId={photoSightingId} />}

      <CatProfileForm
        key={c.id}
        cat={{ ...c, status: cat.status, statusLabel, earTipped: cat.earTipped, neuteredUnconfirmed: cat.unconfirmed }}
        reports={catReports}
      />

      <CatRemove c={c} status={cat.status} />
      {mergeable && <CatMerge key={c.id} cat={{ id: c.id, name: c.name }} others={others} />}

      <section className="mt-6 border-t border-pale pt-4">
        <h3 className="font-extrabold">What happened</h3>
        <div className="mt-3">
          <CatTimeline entries={timeline} onDesk />
        </div>
      </section>
    </>
  );
}

async function Browser({ searchParams }: { searchParams: Promise<{ cat?: string | string[] }> }) {
  await connection();
  const [{ cat: wanted }, q] = await Promise.all([searchParams, getCaretakerQueue()]);
  const list = q.catChoices;
  if (list.length === 0) return <p className="card mt-8">No cats yet.</p>;
  const asked = typeof wanted === "string" && isUuid(wanted) ? list.findIndex((c) => c.id === wanted) : -1;
  const i = asked >= 0 ? asked : 0;
  const c = list[i];
  const href = (j: number) => `/caretaker/cats?cat=${list[(j + list.length) % list.length].id}`;
  return (
    <CatBrowser position={i + 1} total={list.length} prevHref={href(i - 1)} nextHref={href(i + 1)}>
      <Profile c={c} />
    </CatBrowser>
  );
}

export default function CaretakerCatsPage({ searchParams }: PageProps<"/caretaker/cats">) {
  return (
    <main>
      <PageHead title="Cats" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <DeskGate>
          <Browser searchParams={searchParams} />
        </DeskGate>
      </Suspense>
    </main>
  );
}
