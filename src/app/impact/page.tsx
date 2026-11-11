import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { BlockSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { PageSwitch } from "@/components/PageSwitch";
import { FUND_PAGES } from "@/lib/nav";
import { barParts, conservation } from "@/lib/impact";
import { isDemoMode, moneyIsTest } from "@/lib/config";
import { formatPeso } from "@/lib/money";
import { getImpact } from "@/server/impact";

export const metadata: Metadata = { title: "Proof | Stray Fund" };

async function Impact() {
  await connection();
  const impact = await getImpact();
  const c = conservation(impact.pool);
  const bar = barParts(c);
  const counts: [string, number][] = [
    ["Cats neutered", impact.catsNeutered],
    ["Vaccinated", impact.catsVaccinated],
    ["Dewormed", impact.catsDewormed],
    ["Adopted", impact.catsAdopted],
    ["Waiting for help", impact.catsWaiting],
    ["Meals given", impact.meals],
  ];
  return (
    <>
      <section aria-labelledby="adds-up" className="card mt-5">
        <h2 id="adds-up" className="h2">
          Where every peso went
        </h2>
        <p className="mt-2 text-2xl font-extrabold tracking-tight tabular-nums">{formatPeso(c.parts.donated)} donated</p>
        {bar && (
          <>
            <div className="mt-3 flex h-6 gap-0.5 overflow-hidden rounded-in" role="img" aria-label={bar.map((b) => `${b.label} ${formatPeso(b.amount)}`).join(", ")}>
              {bar.map((b) => (
                <span key={b.key} className={`bar-${b.key}`} style={{ flexGrow: b.amount, flexBasis: 0 }} />
              ))}
            </div>
            <ul className="mt-3 grid gap-2">
              {bar.map((b) => (
                <li key={b.key} className="flex items-center gap-3">
                  <span aria-hidden="true" className={`bar-${b.key} h-4 w-4 flex-none rounded-[4px]`} />
                  <span className="flex-1">{b.label}</span>
                  <span className="font-extrabold tabular-nums">{formatPeso(b.amount)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {/* The bar and legend show the sum; the sentence spelling it out shows only when there is no bar. */}
        {bar ? c.note && <p className="mt-4 font-bold leading-snug">{c.note}</p> : <p className="mt-4 font-bold leading-snug">{c.text}</p>}
        {c.balanced ? (
          <p className="note note-ok mt-3">This adds up exactly, across every donation and payout.</p>
        ) : (
          <p role="alert" className="note note-bad mt-3 font-bold">
            These figures do not add up. Please tell a caretaker.
          </p>
        )}
        <p className="small soft mt-3">
          Set aside for cats is money kept for vet visits
          {impact.pool.reservedPayouts > 0 ? `, ${formatPeso(impact.pool.reservedPayouts)} of it on its way to a vet right now` : ""}.
        </p>
        <Link href="/ledger" className="link mt-1">
          See every donation and payment
        </Link>
      </section>

      <section aria-labelledby="done-title" className="mt-8">
        <h2 id="done-title" className="h2">
          What it did
        </h2>
        <dl className="list mt-2">
          {counts.map(([label, n]) => (
            <div key={label} className="row justify-between !min-h-14">
              <dt>{label}</dt>
              <dd className="text-2xl font-extrabold tracking-tight">{n.toLocaleString("en-US")}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 soft">
          {impact.catsNeuteredByFund.toLocaleString("en-US")} by the fund.{" "}
          {impact.alreadyNeutered.toLocaleString("en-US")} {impact.alreadyNeutered === 1 ? "was" : "were"} already neutered when found, as a caretaker confirmed.
        </p>
      </section>

      {/* With DEMO_MODE on, the role strip already says test money on every page. */}
      {moneyIsTest() && !isDemoMode() && (
        <p className="note mt-8">
          All money here is PayPal sandbox test money. Nobody was charged and no vet was paid in real pesos.
        </p>
      )}
    </>
  );
}

export default function ImpactPage() {
  return (
    <main>
      <PageHead title="Proof" action={{ href: "/donate", label: "Donate" }} />
      <PageSwitch label="Fund" pages={FUND_PAGES} current="/impact" />
      <Suspense fallback={<BlockSkeleton label="Loading impact" />}>
        <Impact />
      </Suspense>
    </main>
  );
}
