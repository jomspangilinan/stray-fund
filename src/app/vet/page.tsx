import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookCatForm } from "@/components/BookCatForm";
import { ExactLocation } from "@/components/ExactLocation";
import { SignIn } from "@/components/SignIn";
import { formatPeso } from "@/lib/money";
import { manilaDate } from "@/server/public";
import { getSession } from "@/server/session";
import { listVetDashboard } from "@/server/vetFlow";

export const metadata: Metadata = { title: "Vet | Stray Fund" };

const BOOKING_STATUS: Record<string, string> = { confirmed: "Confirmed", completed: "Completed" };
const CAT_STATUS: Record<string, string> = {
  booked: "Waiting for the deposit",
  in_care: "In care, evidence needed",
  neutered: "Neutered",
  adoptable: "Ready for a home",
  adopted: "Adopted",
};

async function Dashboard() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="ticket mt-8">
        <p className="mb-4 font-bold">Sign in with a vet account to see bookings.</p>
        <SignIn username={null} inline />
      </div>
    );
  }
  if (session.role !== "vet") {
    return <p className="note note-bad mt-8 font-bold">This page is for partner vets.</p>;
  }

  const { fundedCats, bookings } = await listVetDashboard(session.userId);
  const today = manilaDate(new Date());
  return (
    <>
      <section className="mt-8" aria-labelledby="waiting">
        <h2 id="waiting" className="text-3xl font-extrabold">
          Funded, waiting for a booking
        </h2>
        {fundedCats.length === 0 ? (
          <p className="mt-3 text-dusk">No cats are waiting right now.</p>
        ) : (
          <ul className="mt-4 grid gap-5">
            {fundedCats.map((c) => (
              <li key={c.id} className="ticket">
                <h3 className="text-2xl font-extrabold">{c.name}</h3>
                <p className="text-sm text-dusk">
                  {c.sex === "unknown" ? "Sex unknown" : c.sex === "female" ? "Female" : "Male"}, {c.area}
                </p>
                <div className="mt-2">
                  <ExactLocation exact={c.exact} />
                </div>
                <BookCatForm catId={c.id} catName={c.name} today={today} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="mine">
        <h2 id="mine" className="text-3xl font-extrabold">
          Your bookings
        </h2>
        {bookings.length === 0 ? (
          <p className="mt-3 text-dusk">You have no bookings yet.</p>
        ) : (
          <ul className="mt-4 grid gap-5">
            {bookings.map((b) => (
              <li key={b.id} className="ticket">
                <h3 className="text-2xl font-extrabold">{b.catName}</h3>
                <p className="text-sm">
                  {BOOKING_STATUS[b.status] ?? b.status}, visit on {b.scheduledFor ?? "a date to be set"}
                </p>
                <p className="text-sm text-dusk">
                  {CAT_STATUS[b.catStatus] ?? b.catStatus}. Package {formatPeso(b.packagePrice)}.
                </p>
                <div className="mt-2">
                  <ExactLocation exact={b.exact} />
                </div>
                <Link href={`/vet/bookings/${b.id}`} className="btn mt-4 inline-flex items-center">
                  Open booking
                </Link>
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
    <main className="pt-4">
      <h1 className="text-5xl font-extrabold">Vet desk.</h1>
      <p className="mt-4 max-w-[40ch]">Take a funded cat, then send the receipt and a photo once the surgery is done.</p>
      <Suspense fallback={<p className="mt-8 text-dusk">Loading</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}
