import Image from "next/image";

/** A public photo, or a designed placeholder when there is none. Sizes come from the parent box. */
export function CatPhoto({ url, name, sizes = "(min-width: 576px) 20rem, 50vw" }: { url: string | null; name: string; sizes?: string }) {
  if (!url) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-line text-dusk" role="img" aria-label={`No photo yet for ${name}`}>
        <svg viewBox="0 0 64 64" className="h-14 w-14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 54V24l8 6c3-2 7-3 12-3s9 1 12 3l8-6v30c0 0-8 4-20 4s-20-4-20-4Z" />
          <circle cx="25" cy="39" r="2" fill="currentColor" />
          <circle cx="39" cy="39" r="2" fill="currentColor" />
          <path d="M30 45h4" />
        </svg>
        <span className="text-sm font-bold">No photo yet</span>
      </div>
    );
  }
  // Public photos come from S3 or the dev route; unoptimized avoids image host config.
  return <Image src={url} alt={`${name}, a stray cat`} fill sizes={sizes} unoptimized className="object-cover" />;
}
