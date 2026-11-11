"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActiveTab, TABS, type Tab } from "@/lib/nav";

const ICON: Record<Tab["key"], React.ReactNode> = {
  yard: <path d="M12 2.8 2.5 11h2.700v9.200h5.300v-5.800h3v5.800h5.300V11h2.700z" />,
  cats: (
    <path d="M12 13c-2.6 0-5 2.3-5 4.6 0 1.6 1.2 2.4 2.7 2.4 1 0 1.5-.4 2.3-.4s1.3.4 2.3.4c1.5 0 2.7-.8 2.7-2.4 0-2.3-2.4-4.6-5-4.6zM6.2 11.2c1.1 0 1.9-1.1 1.9-2.4S7.300 6.400 6.200 6.400 4.300 7.500 4.300 8.800s.8 2.400 1.900 2.400zm4-2.400c1.100 0 1.900-1.200 1.900-2.600S11.300 3.700 10.200 3.700 8.300 4.800 8.300 6.200s.8 2.600 1.900 2.600zm3.600 0c1.100 0 1.900-1.200 1.900-2.600s-.8-2.500-1.900-2.500-1.900 1.100-1.900 2.500.8 2.600 1.900 2.600zm4 2.400c1.100 0 1.900-1.100 1.900-2.400s-.8-2.400-1.900-2.400-1.900 1.100-1.900 2.400.8 2.400 1.900 2.400z" />
  ),
  fund: <path d="M5 3h14v18l-2.500-1.800L14 21l-2-1.800L10 21l-2.500-1.800L5 21zm3 5v2h8V8zm0 4v2h8v-2z" />,
  spot: <path d="M9 3 7.300 5.500H4A1 1 0 0 0 3 6.500v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-12a1 1 0 0 0-1-1h-3.300L15 3zm3 5.500a4.500 4.500 0 1 1 0 9 4.500 4.500 0 0 1 0-9z" />,
  helped: <path d="M12 21C5.500 15.500 2.500 12 2.500 8.500a4.800 4.800 0 0 1 9.500-1 4.800 4.800 0 0 1 9.500 1c0 3.500-3 7-9.500 12.500z" />,
};

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-pale bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(18,53,42,0.12)] md:border-t-0 md:shadow-none md:inset-y-0 md:right-auto md:w-52 md:px-3 md:pt-20"
    >
      {/* On phones the page fades out just above the bar, so a card scrolling under it does not look cut in half. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-full h-6 bg-linear-to-t from-bg to-transparent md:hidden" />
      <ul className="relative mx-auto flex max-w-xl items-end justify-around px-1 pb-1 pt-1.5 md:grid md:max-w-none md:gap-1 md:p-0">
        {TABS.map((t) => {
          const active = isActiveTab(t, pathname);
          const spot = t.key === "spot";
          return (
            <li key={t.key} className="min-w-0 flex-1 md:flex-none">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`press flex flex-col items-center gap-0.5 rounded-in px-1 py-1 text-[0.8125rem] font-semibold leading-tight md:min-h-11 md:flex-row md:gap-3 md:px-3 md:py-2 md:text-base ${
                  active ? "text-main" : "text-soft"
                } ${active ? "md:bg-pale" : ""}`}
              >
                <span
                  className={
                    spot
                      ? "-mt-5 grid h-14 w-14 place-items-center rounded-out bg-main text-white ring-4 ring-surface md:mt-0 md:ring-0 md:h-9 md:w-9 md:rounded-in"
                      : `grid h-7 w-14 place-items-center rounded-full md:w-7 ${active ? "bg-pale md:bg-transparent" : ""}`
                  }
                >
                  <svg viewBox="0 0 24 24" className={spot ? "h-7 w-7 md:h-5 md:w-5" : "h-6 w-6"} fill="currentColor" aria-hidden="true">
                    {ICON[t.key]}
                  </svg>
                </span>
                <span className={active ? "font-extrabold" : ""}>{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
