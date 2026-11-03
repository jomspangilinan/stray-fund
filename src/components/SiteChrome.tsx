import Link from "next/link";
import { APP_NAME, isDemoMode } from "@/lib/config";
import { consoleFor } from "@/lib/nav";
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
    <Link href="/" className="press -ml-1 inline-flex min-h-11 items-center rounded-in px-1 text-xl font-extrabold tracking-tight text-main">
      {APP_NAME}
    </Link>
  );
}

/** Reads the session cookie, so render it inside Suspense. Only caretakers and vets are handed a console link. */
export async function HeaderSession() {
  const session = await getSession();
  return <SignIn username={session?.username ?? null} console={consoleFor(session?.role)} />;
}
