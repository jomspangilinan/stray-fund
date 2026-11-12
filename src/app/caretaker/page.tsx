import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { EarTips, HeldPhotos, NameSuggestions, NeuteredWithoutRecord } from "@/components/desk/CatCheckSections";
import { DeskGate } from "@/components/desk/DeskGate";
import { DeskJump } from "@/components/desk/DeskJump";
import { EarTipPhotos, Receipts } from "@/components/desk/EvidenceSections";
import { Approvals, LongSent, NeedsReview } from "@/components/desk/PayoutSections";
import { Reports } from "@/components/desk/ReportSection";
import { Sightings } from "@/components/desk/SightingSection";
import { SwipeStack } from "@/components/desk/SwipeStack";
import { Reviews, Wakeups } from "@/components/desk/TreasurerSections";
import { deskTotal } from "@/lib/deskSections";
import { buildCards } from "@/lib/swipeCards";
import { getCaretakerQueue, type CaretakerQueue } from "@/server/caretaker/queue";

export const metadata: Metadata = { title: "To check | Stray Fund" };

async function ToCheck() {
  await connection();
  const q = await getCaretakerQueue();
  if (deskTotal(q) === 0) {
    return (
      <div className="card mt-8">
        <h2 className="title">All done</h2>
        <p className="mt-1 soft">Nothing is waiting for you. If you got something wrong, you can change it on the cat.</p>
        <Link href="/caretaker/cats" className="btn mt-4 inline-flex">
          Look through all cats
        </Link>
      </div>
    );
  }
  const cards = buildCards(q);
  const onCard = new Set(cards.map((c) => c.id));
  const off = <T extends { id: string }>(items: T[]) => items.filter((i) => !onCard.has(i.id));
  // What the cards don't cover keeps today's forms, folded away under the stack.
  const rest: CaretakerQueue = {
    ...q,
    reports: off(q.reports),
    awaitingApproval: off(q.awaitingApproval),
    receipts: off(q.receipts),
    earTipConfirmations: off(q.earTipConfirmations),
    earTipPending: off(q.earTipPending),
    nameSuggestions: off(q.nameSuggestions),
  };
  const restCount = deskTotal(rest);
  const forms: Record<string, React.ReactNode> = Object.fromEntries([
    ...q.reports.filter((r) => onCard.has(r.id)).map((r) => [r.id, <Reports key={r.id} items={[r]} />]),
    ...q.awaitingApproval.filter((p) => onCard.has(p.id)).map((p) => [p.id, <Approvals key={p.id} items={[p]} />]),
    ...q.receipts.filter((r) => onCard.has(r.id)).map((r) => [r.id, <Receipts key={r.id} items={[r]} />]),
    ...q.earTipConfirmations.filter((r) => onCard.has(r.id)).map((r) => [r.id, <EarTipPhotos key={r.id} items={[r]} />]),
    ...q.earTipPending.filter((c) => onCard.has(c.id)).map((c) => [c.id, <EarTips key={c.id} items={[c]} />]),
    ...q.nameSuggestions.filter((n) => onCard.has(n.id)).map((n) => [n.id, <NameSuggestions key={n.id} items={[n]} />]),
  ]);
  return (
    <>
      <SwipeStack cards={cards} forms={forms} alsoWaiting={restCount} />
      {restCount > 0 && (
        <details className="mt-8">
          <summary className="btn-quiet w-full cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            {restCount} more {restCount === 1 ? "needs" : "need"} the full form
          </summary>
          <DeskJump queue={rest} />
          <Reports items={rest.reports} />
          <Approvals items={rest.awaitingApproval} />
          <NeedsReview items={rest.needsReview} />
          <LongSent items={rest.longSent} />
          <Receipts items={rest.receipts} />
          <EarTipPhotos items={rest.earTipConfirmations} />
          <Sightings items={rest.sightings} cats={rest.catChoices} />
          <Reviews items={rest.reviews} />
          <Wakeups items={rest.failedWakeups} />
          <EarTips items={rest.earTipPending} />
          <NeuteredWithoutRecord items={rest.neuteredWithoutRecord} />
          <NameSuggestions items={rest.nameSuggestions} />
          <HeldPhotos items={rest.heldPhotos} />
        </details>
      )}
    </>
  );
}

export default function CaretakerPage() {
  return (
    <main>
      <PageHead title="To check" />
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <DeskGate>
          <ToCheck />
        </DeskGate>
      </Suspense>
    </main>
  );
}
