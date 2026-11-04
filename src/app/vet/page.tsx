import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookCatForm } from "@/components/BookCatForm";
import { ClearCatButton } from "@/components/ClearCatButton";
import { ExactLocation } from "@/components/ExactLocation";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { formatPeso } from "@/lib/money";
import { vetNotice } from "@/lib/reportNotice";
import { manilaDate } from "@/server/public";
import { getSession } from "@/server/session";
import { listVetDashboard, type VetBookingRow } from "@/server/vetFlow";

export const metadata: Metadata = { title: "Vet | Stray Fund" };

const CLAIM_WORD: Record<string, string> = { injured: "hurt", pregnant: "pregnant", sick: "sick" };
const BOOKING_STATUS: Record<string, string> = { confirmed: "Confirmed", completed: "Completed" };
/** What happens next for a booking, in the vet's words. */
const NEXT_STEP: Record<VetBookingRow["evidence"], string> = {
  open: "Send the receipt and a photo of the ear-tip.",
  waiting_deposit: "Waiting for the first payment to reach you.",
  waiting_cat: "Waiting for the cat to come in.",
  checking: "Being checked. Nothing to send.",
  waiting_caretaker: "Waiting for a caretaker. Nothing to send.",
  verified: "Verified. The AI treasurer sends the final payment next.",
  closed: "Closed.",
};

function BookingCard({ b }: { b: VetBookingRow }) {
  return (
    <>
      <h3 className="text-base font-extrabold">{b.catName}</h3>
      <p className="small">
        {BOOKING_STATUS[b.status] ?? b.status}, visit on {b.scheduledFor ?? "a date to be set"}. Package {formatPeso(b.packagePrice)}.
      </p>
      <p className="mt-1 font-bold">{NEXT_STEP[b.evidence]}</p>
      {vetNotice(b.catReport) && <p className="note note-bad mt-2 small font-bold">{vetNotice(b.catReport)}</p>}
      <div className="mt-2">
        <ExactLocation exact={b.exact} area={b.area} exactHidden={b.exactHidden} />
      </div>
      <Link href={`/vet/bookings/${b.id}`} className={`${b.evidence === "open" ? "btn" : "btn-quiet"} mt-4 inline-flex items-center`}>
        {b.evidence === "open" ? `Send for ${b.catName}` : `See ${b.catName}`}
      </Link>
    </>
  );
}

async function Dashboard() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="card mt-8">
        <p className="font-bold">This page is for partner vets.</p>
        <p className="small soft mt-1">In the demo, pick the Vet role in the bar at the top.</p>
      </div>
    );
  }
  if (session.role !== "vet") {
    return <p className="note note-bad mt-8 font-bold">This page is for partner vets.</p>;
  }

  const { checkCats, fundedCats, bookings } = await listVetDashboard(session.userId);
  const today = manilaDate(new Date());
  const send = bookings.filter((b) => b.evidence === "open");
  const rest = bookings.filter((b) => b.evidence !== "open");
  return (
    <>
      {checkCats.length > 0 && (
        <section className="mt-8" aria-labelledby="check">
          <h2 id="check" className="h2">
            Cats to check <span className="soft">({checkCats.length})</span>
          </h2>
          <p className="small soft mt-1">Only clear a cat you&apos;ve seen.</p>
          <ul className="mt-4 grid gap-3">
            {checkCats.map((c) => (
              <li key={c.id} className="card">
                <h3 className="text-base font-extrabold">{c.name}</h3>
                <p className="small">A caretaker says: {c.claims.map((k) => CLAIM_WORD[k] ?? k).join(", ")}.</p>
                <div className="mt-2">
                  <ExactLocation exact={c.exact} area={c.area} exactHidden={c.exactHidden} />
                </div>
                <ClearCatButton catId={c.id} catName={c.name} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={checkCats.length > 0 ? "mt-10" : "mt-8"} aria-labelledby="send">
        <h2 id="send" className="h2">
          Waiting for you {send.length > 0 && <span className="soft">({send.length})</span>}
        </h2>
        {send.length === 0 ? (
          <p className="mt-3 soft">Nothing to send right now.</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {send.map((b) => (
              <li key={b.id} className="card">
                <BookingCard b={b} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="waiting">
        <h2 id="waiting" className="h2">
          Funded, waiting for a booking
        </h2>
        {fundedCats.length === 0 ? (
          <p className="mt-3 soft">No cats are waiting right now.</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {fundedCats.map((c) => (
              <li key={c.id} className="card">
                <h3 className="text-base font-extrabold">{c.name}</h3>
                <p className="small soft">
                  {c.sex === "unknown" ? "Sex unknown" : c.sex === "female" ? "Female" : "Male"}, {c.area}
                </p>
                <div className="mt-2">
                  <ExactLocation exact={c.exact} area={c.area} exactHidden={c.exactHidden} />
                </div>
                <BookCatForm catId={c.id} catName={c.name} today={today} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="mine">
        <h2 id="mine" className="h2">
          Other bookings
        </h2>
        {rest.length === 0 ? (
          <p className="mt-3 soft">{bookings.length === 0 ? "You have no bookings yet." : "Nothing else right now."}</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {rest.map((b) => (
              <li key={b.id} className="card">
                <BookingCard b={b} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function VetPage() {
  return (
    <main>
      <PageHead title="Vet desk">Take a funded cat, then send the receipt and a photo once the surgery is done.</PageHead>
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <Dashboard />
      </Suspense>
    </main>
  );
}
