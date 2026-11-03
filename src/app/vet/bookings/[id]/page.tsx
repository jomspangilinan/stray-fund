import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EvidenceForm } from "@/components/EvidenceForm";
import { ExactLocation } from "@/components/ExactLocation";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { formatPeso } from "@/lib/money";
import { isUuid } from "@/server/public";
import { getSession } from "@/server/session";
import { getVetBooking, type VetBookingView, type VetPayout } from "@/server/vetFlow";

export const metadata: Metadata = { title: "Booking | Stray Fund" };

const PAYOUT_KIND: Record<string, string> = { deposit: "First payment", balance: "Final payment" };
const PAYOUT_STATUS: Record<string, string> = {
  awaiting_approval: "Waiting for a caretaker",
  queued: "Sending",
  sent: "Sent, waiting for PayPal",
  succeeded: "Paid",
  failed: "Failed",
  needs_review: "Being checked",
  rejected: "Rejected",
};
const VERIFICATION: Record<string, string> = {
  pending: "Being checked",
  awaiting_ear_tip_confirmation: "Waiting for a caretaker",
  verified: "Verified",
  needs_review: "A caretaker will look",
  rejected: "Not accepted",
};

function Payouts({ payouts }: { payouts: VetPayout[] }) {
  if (payouts.length === 0) return <p className="mt-2 soft">No payments yet. The AI treasurer sends the first payment shortly after booking.</p>;
  return (
    <ul className="mt-3 grid gap-3">
      {payouts.map((p, i) => (
        <li key={`${p.kind}-${i}`} className="rounded-in bg-bg p-3">
          <p className="text-lg font-extrabold">{formatPeso(p.amount)}</p>
          <p className="small">
            {PAYOUT_KIND[p.kind] ?? p.kind}, {PAYOUT_STATUS[p.status] ?? p.status}, {p.date}
          </p>
          <p className="small break-all soft">PayPal reference: {p.paypalRef ?? "none yet"}</p>
        </li>
      ))}
    </ul>
  );
}

function EvidenceSection({ view }: { view: VetBookingView }) {
  const { evidence, receipt, booking } = view;
  return (
    <section className="mt-8" aria-labelledby="evidence">
      <h2 id="evidence" className="h2">
        Photos and receipt
      </h2>
      {receipt && receipt.verification !== "verified" && (
        <div className={`note mt-3 ${receipt.verification === "rejected" ? "note-bad" : ""}`}>
          <p className="font-bold">
            Last submission, {receipt.submitted}: {VERIFICATION[receipt.verification]}
          </p>
          {receipt.messages.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {receipt.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-4">
        {evidence.state === "open" && <EvidenceForm bookingId={booking.id} catName={booking.catName} />}
        {evidence.state === "waiting_deposit" && (
          <p className="note">The form opens once the first payment has reached you. PayPal can take a few minutes.</p>
        )}
        {evidence.state === "waiting_cat" && <p className="note">The form opens once the cat is in care.</p>}
        {evidence.state === "checking" && <p className="note">Your last submission is still being checked. You do not need to send it again.</p>}
        {evidence.state === "waiting_caretaker" && <p className="note">Waiting for a caretaker. You do not need to send anything again.</p>}
        {evidence.state === "verified" && (
          <p className="note note-ok font-bold">Verified. The AI treasurer sends the final payment next, and it shows above once sent.</p>
        )}
        {evidence.state === "closed" && <p className="note">This booking is closed.</p>}
      </div>
    </section>
  );
}

async function BookingView({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return (
      <div className="card mt-8">
        <p className="font-bold">This page is for partner vets.</p>
        <p className="small soft mt-1">In the demo, pick the Vet role in the bar at the top.</p>
      </div>
    );
  }
  if (session.role !== "vet") return <p className="note note-bad mt-8 font-bold">This page is for partner vets.</p>;

  const { id } = await params;
  if (!isUuid(id)) notFound();
  // Another vet's booking looks the same as one that does not exist.
  const view = await getVetBooking(session.userId, id);
  if (!view) notFound();

  const { booking } = view;
  return (
    <>
      <PageHead title={booking.catName}>
        Visit on {booking.scheduledFor ?? "a date to be set"}. Package {formatPeso(booking.packagePrice)}.
      </PageHead>
      <div className="mt-3">
        <ExactLocation exact={booking.exact} area={booking.area} exactHidden={booking.exactHidden} />
      </div>
      <section className="card mt-8" aria-labelledby="payments">
        <h2 id="payments" className="h2">
          Your payments
        </h2>
        <Payouts payouts={view.payouts} />
      </section>
      <EvidenceSection view={view} />
    </>
  );
}

export default function VetBookingPage({ params }: PageProps<"/vet/bookings/[id]">) {
  return (
    <main>
      <Link href="/vet" className="link -ml-1 px-1">
        All bookings
      </Link>
      <div className="mt-3">
        <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
          <BookingView params={params} />
        </Suspense>
      </div>
    </main>
  );
}
