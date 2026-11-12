import type { Role } from "@/server/session";

export type PageLink = { href: string; label: string };

/** The money pages. The Fund tab opens the first and stays lit on all four. */
export const FUND_PAGES: readonly PageLink[] = [
  { href: "/ledger", label: "Ledger" },
  { href: "/agent", label: "Treasurer" },
  { href: "/priority", label: "Priority" },
  { href: "/impact", label: "Proof" },
];

/** What a neighbour can do. The Helped tab opens the first and stays lit on both. */
export const HELPED_PAGES: readonly PageLink[] = [
  { href: "/helped", label: "Cats I've helped" },
  { href: "/missions", label: "Missions" },
];

export type Tab = {
  key: "yard" | "cats" | "spot" | "helped" | "fund" | "check" | "deskCats" | "rules";
  href: string;
  label: string;
  pages: readonly string[];
  /** Lit on its own page only, not on the pages under it. */
  exact?: boolean;
};

/** The neighbour tabs, for everyone except a caretaker on the desk. */
export const TABS: readonly Tab[] = [
  { key: "yard", href: "/", label: "Yard", pages: ["/"] },
  { key: "cats", href: "/cats", label: "Cats", pages: ["/cats"] },
  { key: "spot", href: "/spot", label: "Spot", pages: ["/spot"] },
  { key: "helped", href: "/helped", label: "Helped", pages: HELPED_PAGES.map((p) => p.href) },
  { key: "fund", href: "/ledger", label: "Fund", pages: FUND_PAGES.map((p) => p.href) },
];

/** A caretaker's tabs while on the desk. To check sits at /caretaker, so it lights only there. */
export const DESK_TABS: readonly Tab[] = [
  { key: "check", href: "/caretaker", label: "To check", pages: ["/caretaker"], exact: true },
  { key: "deskCats", href: "/caretaker/cats", label: "Cats", pages: ["/caretaker/cats"] },
  { key: "rules", href: "/caretaker/rules", label: "Rules", pages: ["/caretaker/rules"] },
];

function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** /caretaker and the pages under it; /caretakers is not. */
export function isOnDesk(pathname: string): boolean {
  return under(pathname, "/caretaker");
}

/** The URL picks the mode: every desk page shows the desk tabs, whoever is looking. DeskGate tells a non-caretaker the page is for caretakers. */
export function tabsFor(pathname: string): readonly Tab[] {
  return isOnDesk(pathname) ? DESK_TABS : TABS;
}

/** The header link, in the same spot on every page: out to the neighbour view from the desk (for anyone, so nobody is stuck there), and back to the desk from anywhere else (for a caretaker only). */
export function deskSwitchFor(role: Role | null | undefined, pathname: string): PageLink | null {
  if (isOnDesk(pathname)) return { href: "/", label: "Neighbour view" };
  return role === "caretaker" ? { href: "/caretaker", label: "Back to desk" } : null;
}

export type ConsoleLink = { href: string; label: string };

/** The console a role opens from the account menu: the vet's only. A caretaker's desk link is in the header (deskSwitchFor). The pages and APIs check the role again. */
export function consoleFor(role: Role | null | undefined): ConsoleLink | null {
  if (role === "vet") return { href: "/vet", label: "Vet desk" };
  return null;
}

/** Whether a tab is the current page. Yard and an exact tab match only their own page; a grouped tab matches each of its pages and what sits under them. */
export function isActiveTab(tab: Tab, pathname: string): boolean {
  return tab.pages.some((page) => (page === "/" || tab.exact ? pathname === page : under(pathname, page)));
}

/** Where the demo role strip takes you. A desk role lands on its desk; any other role keeps the page unless it is a desk page, then the yard. */
export function landingAfterSwitch(role: Role, pathname: string): string {
  if (role === "caretaker") return "/caretaker";
  if (role === "vet") return "/vet";
  return isOnDesk(pathname) || under(pathname, "/vet") ? "/" : pathname;
}
