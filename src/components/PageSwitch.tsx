import Link from "next/link";
import type { PageLink } from "@/lib/nav";

/** A small control at the top of a grouped tab: plain links, one for the page you are on. An optional action sits beside it. */
export function PageSwitch({
  label,
  pages,
  current,
  action,
}: {
  label: string;
  pages: readonly PageLink[];
  current: string;
  action?: PageLink;
}) {
  return (
    <div className="page-switch">
      <nav aria-label={label} className="seg">
        {pages.map((p) => (
          <Link key={p.href} href={p.href} aria-current={p.href === current ? "page" : undefined}>
            {p.label}
          </Link>
        ))}
      </nav>
      {action && (
        <Link href={action.href} className="btn-pop flex-none !min-h-11">
          {action.label}
        </Link>
      )}
    </div>
  );
}
