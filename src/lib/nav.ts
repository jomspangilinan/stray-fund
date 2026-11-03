import type { Role } from "@/server/session";

export type Tab = { key: "cats" | "ledger" | "spot" | "helped" | "agent"; href: string; label: string };

/** The same five tabs for everyone. Roles change what the account menu offers, not the tab bar. */
export const TABS: readonly Tab[] = [
  { key: "cats", href: "/cats", label: "Cats" },
  { key: "ledger", href: "/ledger", label: "Ledger" },
  { key: "spot", href: "/spot", label: "Spot" },
  { key: "helped", href: "/helped", label: "Helped" },
  { key: "agent", href: "/agent", label: "Treasurer" },
];

export type ConsoleLink = { href: string; label: string };

/** The one console a role may open from the account menu. Everyone else gets none. The pages and APIs check the role again. */
export function consoleFor(role: Role | null | undefined): ConsoleLink | null {
  if (role === "caretaker") return { href: "/caretaker", label: "Caretaker desk" };
  if (role === "vet") return { href: "/vet", label: "Vet desk" };
  return null;
}

/** Whether a tab is the current page. The home page marks none. */
export function isActiveTab(tab: Tab, pathname: string): boolean {
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}
