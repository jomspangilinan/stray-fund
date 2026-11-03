"use client";

import Link from "next/link";
import { useState } from "react";
import { AnotherNameButton } from "./AnotherNameButton";
import { CatAvatar } from "./CatAvatar";
import { EarTipAsk } from "./EarTipAsk";
import { SaveImage } from "./SaveImage";
import { SexAsk } from "./SexAsk";
import { revealCopy, type RevealState } from "@/lib/spotCopy";
import type { SpotReveal as Reveal } from "@/server/spotReveal";

/**
 * The one moment after a spot. The card flips in once. Everything on it comes from the server's reveal;
 * when the public photo is not ready it shows the picture already on this device.
 */
export function SpotReveal({
  state,
  catId,
  reveal,
  capturedUrl,
  locationMissing,
  onAgain,
}: {
  state: RevealState;
  catId: string | null;
  reveal: Reveal;
  capturedUrl: string | null;
  locationMissing: boolean;
  onAgain: () => void;
}) {
  // Another name changes the name in place. The rest of the card is what the server sent.
  const [name, setName] = useState(reveal.name);
  // A girl wears a ribbon. When someone answers Girl here it pops on once; a cat who already was a girl just has it.
  const [female, setFemale] = useState(reveal.female);
  const [popped, setPopped] = useState(false);
  const { heading, sub } = revealCopy(state, name);
  const photo = reveal.photoUrl ?? capturedUrl;
  const tags = [reveal.coat, reveal.yourEarTip ? `Your answer: ear-tip ${reveal.yourEarTip}` : null, ...reveal.flags, reveal.probablyFemale ? "Probably female" : null].filter(
    (t): t is string => Boolean(t),
  );
  return (
    <div className="reveal on-main" role="status">
      <div className="mx-auto grid w-full max-w-md gap-6 px-4 pb-10 pt-10">
        <div className="text-center">
          <h1 className="reveal-title">{heading}</h1>
          <p className="mt-2 text-base font-semibold">{sub}</p>
        </div>

        {reveal.avatar && (
          <div className="arrive">
            <div className="arrive-floor" aria-hidden="true" />
            <div className="arrive-cat" aria-hidden="true">
              <CatAvatar avatar={reveal.avatar} id={reveal.catId ?? ""} ribbon={female} ribbonPop={popped} />
            </div>
            <p className="arrive-note small">A look-alike. The photo is the real one.</p>
          </div>
        )}

        <div className="reveal-card">
          <div className="relative aspect-[4/3] w-full bg-pale">
            {photo && (
              // A device photo is a blob: URL and the public one is already scrubbed, so next/image adds nothing.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt="The photo you took" className="h-full w-full object-cover" />
            )}
          </div>
          <div className="grid gap-3 p-4">
            {name && <p className="text-2xl font-extrabold leading-tight tracking-tight">{name}</p>}
            {reveal.canRename && catId && <AnotherNameButton catId={catId} onNamed={setName} />}
            <ul className="flex flex-wrap gap-2" aria-label="What we noticed">
              {tags.map((t) => (
                <li key={t} className="tag">
                  {t}
                </li>
              ))}
              <li className={`tag ${reveal.needsFunding ? "tag-pop" : ""}`}>{reveal.statusLabel}</li>
            </ul>
            {catId && (reveal.askSex || reveal.askEarTip) && (
              <div className="grid gap-5 pt-2">
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
          </div>
        </div>

        {locationMissing && (
          <p className="small text-center">Location not shared, so the card sits mid-colony.</p>
        )}

        <div className="grid gap-3">
          {reveal.needsFunding && (
            <>
              <Link href="/donate" className="btn-pop">
                Help fund the next kapon
              </Link>
              <p className="small text-center">Donations go to one shared fund.</p>
            </>
          )}
          {catId && state !== "needs_review" && (
            <Link href={`/cats/${catId}`} className="btn-quiet">
              See the card
            </Link>
          )}
          <button type="button" className="btn-quiet" onClick={onAgain}>
            Keep spotting
          </button>
          {catId && reveal.photoUrl && state !== "needs_review" && <SaveImage catId={catId} />}
        </div>
      </div>
    </div>
  );
}
