"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { deskSwitchFor } from "@/lib/nav";
import type { Role } from "@/server/session";

/** The header link: "Neighbour view" on any desk page, "Back to desk" for a caretaker anywhere else. */
export function DeskSwitch({ role }: { role: Role | null }) {
  const link = deskSwitchFor(role, usePathname());
  if (!link) return null;
  return (
    <Link href={link.href} className="btn-quiet !min-h-11 !px-3.5">
      {link.label}
    </Link>
  );
}
