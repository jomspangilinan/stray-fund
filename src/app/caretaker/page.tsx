import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { EarTips, HeldPhotos, NameSuggestions, NeuteredWithoutRecord } from "@/components/desk/CatCheckSections";
import { DeskGate } from "@/components/desk/DeskGate";
import { DeskJump } from "@/components/desk/DeskJump";
import { DeskNav } from "@/components/desk/DeskNav";
import { EarTipPhotos, Receipts } from "@/components/desk/EvidenceSections";
import { Approvals, LongSent, NeedsReview } from "@/components/desk/PayoutSections";
import { Sightings } from "@/components/desk/SightingSection";
import { Reviews, Wakeups } from "@/components/desk/TreasurerSections";
import { deskTotal } from "@/lib/deskSections";
import { getCaretakerQueue } from "@/server/caretaker/queue";

export const metadata: Metadata = { title: "To check | Stray Fund" };

async function ToCheck() {
  await connection();
  const q = await getCaretakerQueue();
  if (deskTotal(q) === 0) {
    return (
      <div className="card mt-8">
        <h2 className="title">All done</h2>
        <p className="mt-1 soft">Nothing is waiting for you.</p>
        <Link href="/" className="btn mt-4 inline-flex">
          Back to the yard
        </Link>
      </div>
    );
  }
  return (
    <>
      <DeskJump queue={q} />
      <Approvals items={q.awaitingApproval} />
      <NeedsReview items={q.needsReview} />
      <LongSent items={q.longSent} />
      <Receipts items={q.receipts} />
      <EarTipPhotos items={q.earTipConfirmations} />
      <Sightings items={q.sightings} cats={q.catChoices} />
      <Reviews items={q.reviews} />
      <Wakeups items={q.failedWakeups} />
      <EarTips items={q.earTipPending} />
      <NeuteredWithoutRecord items={q.neuteredWithoutRecord} />
      <NameSuggestions items={q.nameSuggestions} />
      <HeldPhotos items={q.heldPhotos} />
    </>
  );
}

export default function CaretakerPage() {
  return (
    <main>
      <PageHead title="To check">Caretaker desk. Exact places and private photos show here, and nowhere public.</PageHead>
      <DeskNav current="/caretaker" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <DeskGate>
          <ToCheck />
        </DeskGate>
      </Suspense>
    </main>
  );
}
