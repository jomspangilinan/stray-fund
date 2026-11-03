import Link from "next/link";
import { STATUS_GROUPS, STATUS_GROUP_LABEL, type StatusGroup } from "@/server/public";

const GROUPS = Object.keys(STATUS_GROUPS) as StatusGroup[];

/** Filter links for the cat list. Each one is a plain link, so no script is needed. */
export function StatusFilter({ current }: { current: StatusGroup | "all" | null }) {
  return (
    <nav aria-label="Filter cats" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {(["all", ...GROUPS] as const).map((g) => (
        <Link
          key={g}
          href={g === "all" ? "/cats" : `/cats?status=${g}`}
          aria-current={g === current ? "page" : undefined}
          className="chip"
        >
          {g === "all" ? "All" : STATUS_GROUP_LABEL[g]}
        </Link>
      ))}
    </nav>
  );
}
