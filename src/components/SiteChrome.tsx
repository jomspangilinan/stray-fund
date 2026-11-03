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
