"use client";

import Link from "next/link";
import { useState } from "react";
import { AnotherNameButton } from "./AnotherNameButton";
import { CatAvatar } from "./CatAvatar";
import { COURT } from "@/lib/courtyard";
import { EarTipAsk } from "./EarTipAsk";
import { ReportCat } from "./ReportCat";
import { SaveImage } from "./SaveImage";
import { SexAsk } from "./SexAsk";
import { developLines } from "@/lib/developPoll";
import type { Avatar } from "@/lib/avatar";
import { revealCopy, type RevealState } from "@/lib/spotCopy";
import { JUDGE_ONLY_LINE } from "@/lib/judgeLine";
import type { SpotReveal as Reveal } from "@/server/spotReveal";

/**
 * The one moment after a spot. The card flips in once. Everything on it comes from the server's reveal;
 * when the public photo is not ready it shows the picture already on this device.
 */
export function SpotReveal({
  state,
  catId,
  sightingId,
  reveal,
  capturedUrl,
  locationMissing,
  judge,
  develop,
  onAgain,
}: {
  state: RevealState;
  catId: string | null;
  sightingId: string | null;
  reveal: Reveal;
  capturedUrl: string | null;
  locationMissing: boolean;
  judge: boolean;
  /** Public path only: how far the photo has got. The cat is already in the yard; the photo and its colours follow. */
  develop?: { developed: boolean; soon: boolean; photoUrl: string | null; avatar: Avatar | null };
  onAgain: () => void;
}) {
  // Another name changes the name in place. The rest of the card is what the server sent.
  const [name, setName] = useState(reveal.name);
  // A girl wears a ribbon. When someone answers Girl here it pops on once; a cat who already was a girl just has it.
  const [female, setFemale] = useState(reveal.female);
  const [popped, setPopped] = useState(false);
  const { heading, sub } = revealCopy(state, name);
  const publicPhoto = develop?.photoUrl ?? reveal.photoUrl;
  const photo = publicPhoto ?? capturedUrl;
  const avatar = develop?.avatar ?? reveal.avatar;
  const lines = develop ? developLines(develop) : null;
  const developing = Boolean(develop && !develop.developed);
  const tipTag = reveal.yourEarTip === "yes" ? "You said: tipped ear" : reveal.yourEarTip === "no" ? "You said: not tipped" : null;
  const tags = [reveal.coat, tipTag, ...reveal.flags, reveal.probablyFemale ? "Probably female" : null].filter((t): t is string => Boolean(t));
  const hasMore = Boolean(catId) && judge && (reveal.canRename || reveal.askSex || reveal.askEarTip);
  const card = (
    <div className="reveal-card flex items-stretch">
      <div className="relative w-28 flex-none rounded-l-out bg-pale">
        {photo && (
          // A device photo is a blob: URL and the public one is already scrubbed, so next/image adds nothing.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt="The photo you took"
            className={`absolute inset-0 h-full w-full rounded-l-out object-cover ${developing ? "develop-pulse" : ""}`}
          />
        )}
        {lines?.card && (
          <span className="develop-tag small font-bold" role="status">
            {lines.card}
          </span>
        )}
      </div>
      <div className="grid min-w-0 flex-1 content-center gap-2 p-3">
        {name && <p className="break-words text-xl font-extrabold leading-tight tracking-tight">{name}</p>}
        <ul className="flex flex-wrap gap-2" aria-label="What we noticed">
          {tags.map((t) => (
            <li key={t} className="tag">
              {t}
            </li>
          ))}
          <li className={`tag ${reveal.needsFunding ? "tag-pop" : ""}`}>{reveal.statusLabel}</li>
        </ul>
      </div>
    </div>
  );
  return (
    <div className="reveal on-main" role="status">
      <div className="mx-auto grid w-full max-w-md gap-4 px-4 pb-10 pt-6">
        <div className="text-center">
          <h1 className="reveal-title">{heading}</h1>
          <p className="mt-1 text-base font-semibold">{sub}</p>
        </div>

        {avatar && (
          <div className="arrive arrive-short" style={{ "--court-wall": COURT.wall, "--court-floor": COURT.floor } as React.CSSProperties}>
            <div className="arrive-floor" aria-hidden="true" />
            <div className="arrive-cat" aria-hidden="true">
              <span key={develop?.developed ? "developed" : "first"} className={develop?.developed && develop.avatar ? "develop-pop" : undefined}>
                <CatAvatar avatar={avatar} id={reveal.catId ?? ""} ribbon={female} ribbonPop={popped} />
              </span>
            </div>
            <p className="arrive-note small">A look-alike. The photo is the real one.</p>
          </div>
        )}

        {lines && <p className="text-center font-bold">{lines.yard}</p>}

        {catId && publicPhoto && state !== "needs_review" ? (
          <SaveImage catId={catId} variant="button">
            {card}
          </SaveImage>
        ) : (
          card
        )}

        <div className="grid gap-2">
          {reveal.needsFunding ? (
            <>
              <Link href="/donate" className="btn-pop">
                Help fund this cat
              </Link>
              <p className="small text-center">Gifts go to one shared fund.</p>
            </>
          ) : (
            catId &&
            state !== "needs_review" && (
              <Link href={`/cats/${catId}`} className="btn-quiet">
                See the card
              </Link>
            )
          )}
          <div className="flex items-center justify-center gap-2">
            {reveal.needsFunding && catId && state !== "needs_review" && (
              <Link href={`/cats/${catId}`} className="reveal-link">
                See the card
              </Link>
            )}
            <button type="button" className="reveal-link" onClick={onAgain}>
              Keep spotting
            </button>
          </div>
        </div>

        {sightingId && (judge ? <ReportCat sightingId={sightingId} photo={capturedUrl ?? reveal.photoUrl} /> : <p className="small soft text-center">{JUDGE_ONLY_LINE}</p>)}

        {hasMore && catId && (
          <div className="reveal-more grid gap-4">
            <p className="small soft font-bold">Add details. Optional.</p>
            {reveal.canRename && <AnotherNameButton catId={catId} onNamed={setName} />}
            {reveal.askSex && (
              <SexAsk
                catId={catId}
                onSex={(sex) => {
                  if (sex === "female" && !female) {
                    setPopped(true);
                    setFemale(true);
                  }
                }}
              />
            )}
            {reveal.askEarTip && <EarTipAsk catId={catId} initial="unsure" bare />}
          </div>
        )}

        {locationMissing && (
          <p className="small text-center">Location not shared, so the card is placed in the middle of the area.</p>
        )}
      </div>
    </div>
  );
}
