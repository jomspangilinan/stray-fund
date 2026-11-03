import Link from "next/link";
import type { PublicCat } from "@/server/public";
import { CatPhoto } from "./CatPhoto";

/** Accessible progress: the words carry it, the segments only picture it. */
export function Progress({ cat }: { cat: Pick<PublicCat, "journey"> }) {
  const total = cat.journey.length;
  const done = cat.journey.filter((s) => s.done).length;
  if (total === 0) return null;
  return (
    <span className="mt-1 flex items-center gap-2">
      <span className="steps" aria-hidden="true">
        {cat.journey.map((s) => (
          <i key={s.step} className={s.done ? "on" : ""} />
        ))}
      </span>
      <span className="small soft whitespace-nowrap">
        {done} of {total} steps
      </span>
    </span>
  );
}

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
          <Progress cat={cat} />
        </span>
      </Link>
      {footer && <div className="px-3 pb-3 pl-[76px]">{footer}</div>}
    </li>
  );
}
