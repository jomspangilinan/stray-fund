import Image from "next/image";

const TONES = ["var(--t1)", "var(--t2)", "var(--t3)", "var(--t4)"];

function toneFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return TONES[h % TONES.length];
}

/**
 * A public photo, or a placeholder when there is none: the cat's initial on a tone picked from its name.
 * Sizes come from the parent box. Pass `caption` on large boxes to say the photo is missing in words.
 */
export function CatPhoto({
  url,
  name,
  sizes = "(min-width: 576px) 20rem, 50vw",
  caption = false,
}: {
  url: string | null;
  name: string;
  sizes?: string;
  caption?: boolean;
}) {
  if (!url) {
    return (
      <div
        className="grid h-full w-full place-items-center text-ink"
        style={{ background: toneFor(name), containerType: "size" }}
        role="img"
        aria-label={`No photo yet for ${name}`}
      >
        <span className="flex flex-col items-center leading-none">
          <span aria-hidden="true" className="font-extrabold" style={{ fontSize: "min(46cqmin, 5rem)" }}>
            {name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          {caption && <span className="small mt-2 font-semibold">No photo yet</span>}
        </span>
      </div>
    );
  }
  // Public photos come from S3 or the dev route; unoptimized avoids image host config.
  return <Image src={url} alt={`${name}, a stray cat`} fill sizes={sizes} unoptimized className="object-cover" />;
}
