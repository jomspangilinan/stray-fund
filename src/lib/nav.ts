import type { Role } from "@/server/session";

export type Tab = { key: "home" | "cats" | "ledger" | "spot" | "helped"; href: string; label: string };

/** The same five tabs for everyone (the Treasurer feed at /agent is public and linked from Ledger and Home). Roles change what the account menu offers, not the tab bar. */
export const TABS: readonly Tab[] = [
  { key: "home", href: "/", label: "Home" },
  { key: "cats", href: "/cats", label: "Cats" },
  { key: "spot", href: "/spot", label: "Spot" },
  { key: "helped", href: "/helped", label: "Helped" },
  { key: "ledger", href: "/ledger", label: "Ledger" },
];

export type ConsoleLink = { href: string; label: string };

/** The one console a role may open from the account menu. Everyone else gets none. The pages and APIs check the role again. */
export function consoleFor(role: Role | null | undefined): ConsoleLink | null {
  if (role === "caretaker") return { href: "/caretaker", label: "Caretaker desk" };
  if (role === "vet") return { href: "/vet", label: "Vet desk" };
  return null;
}

/** Whether a tab is the current page. Home matches only the home page itself. */
export function isActiveTab(tab: Tab, pathname: string): boolean {
  if (tab.href === "/") return pathname === "/";
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}
