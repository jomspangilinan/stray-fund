import Link from "next/link";
import type { PageLink } from "@/lib/nav";

/** A small control under the page title of a grouped tab: plain links, one for the page you are on. */
export function PageSwitch({ label, pages, current }: { label: string; pages: readonly PageLink[]; current: string }) {
  return (
    <div className="page-switch mt-4">
      <nav aria-label={label} className="seg">
        {pages.map((p) => (
          <Link key={p.href} href={p.href} aria-current={p.href === current ? "page" : undefined}>
            {p.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
