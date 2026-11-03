import Link from "next/link";
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
  const { heading, sub } = revealCopy(state, reveal.name);
  const photo = reveal.photoUrl ?? capturedUrl;
  const tags = [reveal.coat, reveal.earTip, ...reveal.flags, reveal.probablyFemale ? "Probably female" : null].filter(
    (t): t is string => Boolean(t),
  );
  return (
    <div className="reveal on-main" role="status">
      <div className="mx-auto grid w-full max-w-md gap-6 px-4 pb-10 pt-10">
        <div className="text-center">
          <h1 className="reveal-title">{heading}</h1>
          <p className="mt-2 text-base font-semibold">{sub}</p>
        </div>

        <div className="reveal-card">
          <div className="relative aspect-[4/3] w-full bg-pale">
            {photo && (
              // A device photo is a blob: URL and the public one is already scrubbed, so next/image adds nothing.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt="The photo you took" className="h-full w-full object-cover" />
            )}
          </div>
          <div className="grid gap-3 p-4">
            {reveal.name && <p className="text-2xl font-extrabold leading-tight tracking-tight">{reveal.name}</p>}
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
        </div>
      </div>
    </div>
  );
}
