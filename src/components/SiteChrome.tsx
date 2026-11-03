import Link from "next/link";
import { Suspense } from "react";
import { APP_NAME, isDemoMode } from "@/lib/config";
import { getSession } from "@/server/session";
import { PersonaSwitcher } from "./PersonaSwitcher";
import { SignIn } from "./SignIn";

/** Reads the session cookie, so render it inside Suspense. */
export async function DemoBar() {
  if (!isDemoMode()) return null;
  const session = await getSession();
  return <PersonaSwitcher current={session?.username ?? null} />;
}

export function Brand() {
  return (
    <Link
      href="/"
      className="font-display text-2xl font-extrabold tracking-tight"
      style={{ boxShadow: "inset 0 -0.35em 0 var(--sign)" }}
    >
      {APP_NAME}
    </Link>
  );
}

/** Reads the session cookie, so render it inside Suspense. */
export async function HeaderSession() {
  const session = await getSession();
  return <SignIn username={session?.username ?? null} />;
}

const LINKS = [
  { href: "/cats", label: "Cats" },
  { href: "/collection", label: "Collection" },
  { href: "/catch", label: "Catch" },
  { href: "/donate", label: "Donate" },
  { href: "/agent", label: "Treasurer" },
] as const;

const NAV_LINK = "inline-flex min-h-8 items-center underline-offset-4 hover:underline";

/** Reads the session cookie, so render it inside Suspense. Only vets ever receive this link. */
async function VetNavItem() {
  const session = await getSession();
  if (session?.role !== "vet") return null;
  return (
    <li>
      <Link href="/vet" className={NAV_LINK}>
        Vet
      </Link>
    </li>
  );
}

/** Reads the session cookie, so render it inside Suspense. Only caretakers ever receive this link. */
async function CaretakerNavItem() {
  const session = await getSession();
  if (session?.role !== "caretaker") return null;
  return (
    <li>
      <Link href="/caretaker" className={NAV_LINK}>
        Caretaker
      </Link>
    </li>
  );
}

export function SiteNav() {
  return (
    <nav aria-label="Main" className="mx-auto w-full max-w-xl px-4 pb-2">
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-bold">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={NAV_LINK}>
              {l.label}
            </Link>
          </li>
        ))}
        <Suspense fallback={null}>
          <VetNavItem />
        </Suspense>
        <Suspense fallback={null}>
          <CaretakerNavItem />
        </Suspense>
      </ul>
    </nav>
  );
}
