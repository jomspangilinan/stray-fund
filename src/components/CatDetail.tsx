import Link from "next/link";
import type { CatCardData } from "@/server/public";
import { CatPhoto } from "./CatPhoto";
import { Progress } from "./CatRow";
import { JourneyTimeline, niceDate } from "./JourneyTimeline";

export function CatDetail({ card }: { card: CatCardData }) {
  const { cat, sightings, health } = card;
  return (
    <article className="grid gap-8">
      <header>
        <Link href="/cats" className="link -ml-1 px-1">
          All cats
        </Link>
        <div className="relative mt-1 aspect-[4/3] overflow-hidden rounded-out">
          <CatPhoto url={cat.photoUrl} name={cat.name} sizes="(min-width: 576px) 36rem, 100vw" caption />
        </div>
        <h1 className="title mt-4">{cat.name}</h1>
        <p className="mt-1 soft">
          {cat.sex}, {cat.statusLabel.toLowerCase()}
        </p>
        <Progress cat={cat} />
        {cat.flags.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {cat.flags.map((f) => (
              <li key={f} className="tag">
                {f}
              </li>
            ))}
          </ul>
        )}
        {cat.bio && <p className="mt-4 max-w-[52ch]">{cat.bio}</p>}
      </header>

      <section aria-labelledby="where">
        <h2 id="where" className="h2">
          Where
        </h2>
        <p className="mt-1 font-semibold">{cat.area}</p>
        <p className="small soft mt-1 max-w-[52ch]">
          Exact spots are private to protect the cats. If you spot or meet this cat, please do not post its exact
          location anywhere else.
        </p>
      </section>

      <section aria-labelledby="journey">
        <h2 id="journey" className="h2 mb-3">
          Journey
        </h2>
        <div className="card">
          <JourneyTimeline steps={cat.journey} />
        </div>
      </section>

      <section aria-labelledby="health">
        <h2 id="health" className="h2 mb-3">
          Health record
        </h2>
        {health.length === 0 ? (
          <p className="note">Nothing recorded yet.</p>
        ) : (
          <ul className="list">
            {health.map((h) => (
              <li key={h.id} className="p-3">
                <p className="font-bold">
                  {h.type}
                  {h.product ? `: ${h.product}` : ""}
                </p>
                <p className="small soft">
                  {niceDate(h.date)}
                  {h.vet ? ` by ${h.vet}` : ""}
                </p>
                {h.nextDue && (
                  <p className={`small mt-1 ${h.overdue ? "font-bold text-main" : ""}`}>
                    {h.overdue ? "Due now, since " : "Next due "}
                    {niceDate(h.nextDue)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sightings">
        <h2 id="sightings" className="h2 mb-3">
          Sightings ({sightings.length})
        </h2>
        {sightings.length === 0 ? (
          <p className="note">No sightings yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {sightings.map((s) => (
              <li key={s.id}>
                <div className="relative aspect-square overflow-hidden rounded-in">
                  <CatPhoto url={s.photoUrl} name={cat.name} sizes="(min-width: 576px) 12rem, 50vw" />
                </div>
                <p className="small soft mt-1">{niceDate(s.date)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link href="/donate" className="btn-pop">
        Help fund the colony
      </Link>
    </article>
  );
}
