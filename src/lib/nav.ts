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
  key: "yard" | "cats" | "spot" | "helped" | "fund" | "check" | "deskCats" | "rules" | "todo" | "bookings";
  href: string;
  label: string;
  pages: readonly string[];
  /** Lit on its own page only, not on the pages under it. */
  exact?: boolean;
};

/** The neighbour tabs, for every page that is not a desk. */
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

/** A vet's tabs while on the desk. To do sits at /vet, so it lights only there; Bookings stays lit on a booking. */
export const VET_TABS: readonly Tab[] = [
  { key: "todo", href: "/vet", label: "To do", pages: ["/vet"], exact: true },
  { key: "bookings", href: "/vet/bookings", label: "Bookings", pages: ["/vet/bookings"] },
];

export type Desk = "caretaker" | "vet";
const DESK_HOME: Record<Desk, string> = { caretaker: "/caretaker", vet: "/vet" };
export const DESK_NAME: Record<Desk, string> = { caretaker: "Caretaker desk", vet: "Vet desk" };

function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** Which desk a page belongs to: /caretaker and /vet and the pages under them. /caretakers and /vets are not desks. */
export function deskOf(pathname: string): Desk | null {
  if (under(pathname, "/caretaker")) return "caretaker";
  if (under(pathname, "/vet")) return "vet";
  return null;
}

export const isOnDesk = (pathname: string): boolean => deskOf(pathname) !== null;

/** The URL picks the mode: every desk page shows that desk's tabs, whoever is looking. The page tells a visitor without the role who it is for. */
export function tabsFor(pathname: string): readonly Tab[] {
  const desk = deskOf(pathname);
  return desk === "caretaker" ? DESK_TABS : desk === "vet" ? VET_TABS : TABS;
}

/** The header link, in the same spot on every page: out to the neighbour view from any desk (for anyone, so nobody is stuck there), and back to their own desk from anywhere else (for a caretaker or a vet). */
export function deskSwitchFor(role: Role | null | undefined, pathname: string): PageLink | null {
  if (isOnDesk(pathname)) return { href: "/", label: "Neighbour view" };
  return role === "caretaker" || role === "vet" ? { href: DESK_HOME[role], label: "Back to desk" } : null;
}

/** Whether a tab is the current page. Yard and an exact tab match only their own page; a grouped tab matches each of its pages and what sits under them. */
export function isActiveTab(tab: Tab, pathname: string): boolean {
  return tab.pages.some((page) => (page === "/" || tab.exact ? pathname === page : under(pathname, page)));
}

/** Where the demo role strip takes you. A desk role lands on its desk; any other role keeps the page unless it is a desk page, then the yard. */
export function landingAfterSwitch(role: Role, pathname: string): string {
  if (role === "caretaker" || role === "vet") return DESK_HOME[role];
  return isOnDesk(pathname) ? "/" : pathname;
}
