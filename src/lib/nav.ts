import type { Role } from "@/server/session";

export type PageLink = { href: string; label: string };

/** The money pages. The Fund tab opens the first and stays lit on all three. */
export const FUND_PAGES: readonly PageLink[] = [
  { href: "/ledger", label: "Money" },
  { href: "/agent", label: "AI helper" },
  { href: "/impact", label: "Proof" },
];

/** What a neighbour can do. The Helped tab opens the first and stays lit on both. */
export const HELPED_PAGES: readonly PageLink[] = [
  { href: "/helped", label: "Cats I've helped" },
  { href: "/missions", label: "Missions" },
];

export type Tab = { key: "yard" | "cats" | "spot" | "helped" | "fund"; href: string; label: string; pages: readonly string[] };

/** The same five tabs for everyone. Roles change what the account menu offers, not the tab bar. */
export const TABS: readonly Tab[] = [
  { key: "yard", href: "/", label: "Yard", pages: ["/"] },
  { key: "cats", href: "/cats", label: "Cats", pages: ["/cats"] },
  { key: "spot", href: "/spot", label: "Spot", pages: ["/spot"] },
  { key: "helped", href: "/helped", label: "Helped", pages: HELPED_PAGES.map((p) => p.href) },
  { key: "fund", href: "/ledger", label: "Fund", pages: FUND_PAGES.map((p) => p.href) },
];

export type ConsoleLink = { href: string; label: string };

/** The one console a role may open from the account menu. Everyone else gets none. The pages and APIs check the role again. */
export function consoleFor(role: Role | null | undefined): ConsoleLink | null {
  if (role === "caretaker") return { href: "/caretaker", label: "Caretaker desk" };
  if (role === "vet") return { href: "/vet", label: "Vet desk" };
  return null;
}

/** Whether a tab is the current page. Yard matches only the home page itself; a grouped tab matches each of its pages. */
export function isActiveTab(tab: Tab, pathname: string): boolean {
  return tab.pages.some((page) => (page === "/" ? pathname === "/" : pathname === page || pathname.startsWith(`${page}/`)));
}

/** Where the demo role strip takes you. A desk role lands on its desk; any other role keeps the page unless it is a desk page, then the yard. */
export function landingAfterSwitch(role: Role, pathname: string): string {
  if (role === "caretaker") return "/caretaker";
  if (role === "vet") return "/vet";
  const onDesk = ["/caretaker", "/vet"].some((d) => pathname === d || pathname.startsWith(`${d}/`));
  return onDesk ? "/" : pathname;
}
