import Link from "next/link";
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

export function SiteNav() {
  return (
    <nav aria-label="Main" className="mx-auto w-full max-w-xl px-4 pb-2">
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-bold">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="inline-flex min-h-8 items-center underline-offset-4 hover:underline">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
