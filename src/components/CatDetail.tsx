import Link from "next/link";
import type { CatCardData } from "@/server/public";
import { CatPhoto } from "./CatPhoto";
import { JourneyTimeline, niceDate } from "./JourneyTimeline";

export function CatDetail({ card }: { card: CatCardData }) {
  const { cat, sightings, health } = card;
  return (
    <article className="grid gap-8 pt-2">
      <header>
        <div className="relative aspect-[4/3] overflow-hidden rounded-md border-2 border-ink" style={{ boxShadow: "3px 3px 0 var(--ink)" }}>
          <CatPhoto url={cat.photoUrl} name={cat.name} sizes="(min-width: 576px) 36rem, 100vw" />
        </div>
        <h1 className="mt-5 text-5xl font-extrabold">{cat.name}</h1>
        <p className="mt-2 text-dusk">
          {cat.sex} &middot; {cat.statusLabel}
        </p>
        {cat.flags.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {cat.flags.map((f) => (
              <li key={f} className="border-2 border-ink bg-paper px-2 text-sm font-bold">
                {f}
              </li>
            ))}
          </ul>
        )}
        {cat.bio && <p className="mt-4 max-w-[48ch]">{cat.bio}</p>}
      </header>

      <section aria-labelledby="where">
        <h2 id="where" className="text-2xl font-extrabold">
          Where
        </h2>
        <p className="mt-2 font-bold">{cat.area}</p>
        <p className="mt-1 text-sm text-dusk">
          Exact spots are private to protect the cats. If you catch or meet this cat, please do not post its exact
          location anywhere else.
        </p>
      </section>

      <section aria-labelledby="journey">
        <h2 id="journey" className="mb-3 text-2xl font-extrabold">
          Journey
        </h2>
        <JourneyTimeline steps={cat.journey} />
      </section>

      <section aria-labelledby="health">
        <h2 id="health" className="mb-3 text-2xl font-extrabold">
          Health record
        </h2>
        {health.length === 0 ? (
          <p className="text-dusk">Nothing recorded yet.</p>
        ) : (
          <ul className="grid gap-3">
            {health.map((h) => (
              <li key={h.id} className="note">
                <p className="font-bold">
                  {h.type}
                  {h.product ? `: ${h.product}` : ""}
                </p>
                <p className="text-sm text-dusk">
                  {niceDate(h.date)}
                  {h.vet ? ` by ${h.vet}` : ""}
                </p>
                {h.nextDue && (
                  <p className={h.overdue ? "mt-1 text-sm font-bold text-chili" : "mt-1 text-sm"}>
                    {h.overdue ? "Overdue, was due " : "Next due "}
                    {niceDate(h.nextDue)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sightings">
        <h2 id="sightings" className="mb-3 text-2xl font-extrabold">
          Sightings ({sightings.length})
        </h2>
        {sightings.length === 0 ? (
          <p className="text-dusk">No sightings yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3">
            {sightings.map((s) => (
              <li key={s.id}>
                <div className="relative aspect-square overflow-hidden border-2 border-ink">
                  <CatPhoto url={s.photoUrl} name={cat.name} sizes="50vw" />
                </div>
                <p className="mt-1 text-sm text-dusk">{niceDate(s.date)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link href="/donate" className="btn inline-flex items-center justify-center">
        Help fund the colony
      </Link>
    </article>
  );
}
