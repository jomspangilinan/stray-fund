import Link from "next/link";
import type { PublicCat } from "@/server/public";
import { CatPhoto } from "./CatPhoto";

/** A grid card. Takes only serialized public data. */
export function CatCard({ cat, footer }: { cat: PublicCat; footer?: React.ReactNode }) {
  return (
    <li className="ticket flex flex-col !p-0 !pb-0">
      <Link href={`/cats/${cat.id}`} className="block">
        <div className="relative aspect-[4/3] overflow-hidden rounded-t-[4px] border-b-2 border-ink">
          <CatPhoto url={cat.photoUrl} name={cat.name} />
        </div>
        <div className="px-4 pt-3">
          <h2 className="text-2xl font-extrabold">{cat.name}</h2>
          <p className="mt-1 text-sm text-dusk">
            {cat.sex} &middot; {cat.area}
          </p>
          <p className="mt-2 inline-block border-2 border-ink bg-sign px-2 text-sm font-bold">{cat.statusLabel}</p>
        </div>
      </Link>
      <div className="px-4 pb-5 pt-2">{footer}</div>
    </li>
  );
}
