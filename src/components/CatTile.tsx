import Link from "next/link";
import type { PublicCat } from "@/server/public";
import { CatPhoto } from "./CatPhoto";

const NEEDS_FUNDING = "Waiting for funding";

/** A big cat picture with a name, a status and one short line. Public data only. */
export function CatTile({ cat, line }: { cat: PublicCat; line?: React.ReactNode }) {
  const done = cat.journey.filter((s) => s.done).length;
  return (
    <li className="tile">
      <Link href={`/cats/${cat.id}`} className="press block">
        <span className="relative block aspect-[4/5] w-full overflow-hidden rounded-out">
          <CatPhoto url={cat.photoUrl} name={cat.name} sizes="(min-width: 576px) 16rem, 50vw" />
        </span>
        <span className="mt-2 block px-1 text-base font-extrabold leading-tight">{cat.name}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
          <span className={`tag ${cat.statusLabel === NEEDS_FUNDING ? "tag-pop" : ""}`}>
            {cat.statusLabel === NEEDS_FUNDING ? "Needs funding" : cat.statusLabel}
          </span>
          <span className="small soft">{line ?? `${done} of ${cat.journey.length} steps`}</span>
        </span>
      </Link>
    </li>
  );
}
