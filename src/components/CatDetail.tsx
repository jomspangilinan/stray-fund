import Link from "next/link";
import { earTipAskable } from "@/lib/catState";
import type { CatCardData } from "@/server/public";
import type { Thanks } from "@/server/thanks";
import type { NameControls } from "@/server/catNames";
import { CatPhoto } from "./CatPhoto";
import { EarTipAsk } from "./EarTipAsk";
import type { EarTipAnswer } from "./EarTipChoice";
import { Progress } from "./CatRow";
import { JourneyTimeline, niceDate } from "./JourneyTimeline";
import { CatNameEditor } from "./CatNameEditor";
import { SaveImage } from "./SaveImage";
import { SexAsk } from "./SexAsk";

export function CatDetail({
  card,
  thanks = [],
  earTip,
  names,
  askSex = false,
}: {
  card: CatCardData;
  thanks?: Thanks[];
  /** Set only for a signed-in person: their own answer. Nobody else's is ever passed in. */
  earTip?: EarTipAnswer;
  /** Set only for a signed-in person: whether they may ask for another name, and their own pending suggestion. */
  names?: NameControls;
  /** Set only for a signed-in person, and only while the card does not say girl or boy. */
  askSex?: boolean;
}) {
  const { cat, sightings, health } = card;
  return (
    <article className="grid gap-8">
      <header>
        <Link href="/cats" className="link -ml-1 px-1">
          All cats
        </Link>
        <div className="relative mt-1 aspect-[4/5] overflow-hidden rounded-out">
          <CatPhoto url={cat.photoUrl} name={cat.name} sizes="(min-width: 576px) 36rem, 100vw" caption />
        </div>
        <CatNameEditor catId={cat.id} name={cat.name} names={names} />
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

      {askSex && (
        <section className="card">
          <SexAsk catId={cat.id} refresh />
        </section>
      )}

      {earTip !== undefined && earTipAskable(cat.status) && (
        <EarTipAsk catId={cat.id} initial={earTip} />
      )}

      <section aria-labelledby="where">
        <h2 id="where" className="h2">
          Where
        </h2>
        <p className="mt-1 font-semibold">{cat.area}</p>
        <p className="small soft mt-1 max-w-[52ch]">
          Exact spot kept private. Please do not post it.
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

      {thanks.length > 0 && (
        <section aria-labelledby="thanks">
          <h2 id="thanks" className="h2 mb-3">
            Thanks to
          </h2>
          <ul className="grid gap-2">
            {thanks.map((t, i) => (
              <li key={i} className="card !py-3">
                <p>
                  <strong>{t.name}</strong> {t.text}
                </p>
                {t.badges.length > 0 && <p className="small soft mt-1">{t.badges.join(", ")}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href="/donate" className="btn-pop">
        Help fund the colony
      </Link>
      {cat.photoUrl && <SaveImage catId={cat.id} />}
    </article>
  );
}
