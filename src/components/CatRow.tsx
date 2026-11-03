import Link from "next/link";
import type { PublicCat } from "@/server/public";
import { CatPhoto } from "./CatPhoto";

const NEEDS_FUNDING = "Waiting for funding";

/** One cat in a list. Takes only serialized public data. */
export function CatRow({ cat, footer }: { cat: PublicCat; footer?: React.ReactNode }) {
  return (
    <li>
      <Link href={`/cats/${cat.id}`} className="press row">
        <span className="relative h-[52px] w-[52px] flex-none overflow-hidden rounded-in">
          <CatPhoto url={cat.photoUrl} name={cat.name} sizes="52px" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0 truncate text-base font-bold leading-tight">{cat.name}</span>
            <span className={`tag max-w-[55%] flex-none !whitespace-normal ${cat.statusLabel === NEEDS_FUNDING ? "tag-pop" : ""}`}>
              {cat.statusLabel === NEEDS_FUNDING ? "Needs funding" : cat.statusLabel}
            </span>
          </span>
          <span className="small soft block truncate">
            {cat.sex}
            {cat.flags.length > 0 ? `, ${cat.flags.join(", ").toLowerCase()}` : ""}
          </span>
        </span>
      </Link>
      {footer && <div className="px-3 pb-3 pl-[76px]">{footer}</div>}
    </li>
  );
}
