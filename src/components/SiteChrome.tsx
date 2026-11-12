import Link from "next/link";
import { APP_NAME, isDemoMode, moneyIsTest } from "@/lib/config";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { isJudge } from "@/server/judge";
import { getSession } from "@/server/session";
import { PersonaSwitcher } from "./PersonaSwitcher";
import { SignIn } from "./SignIn";

/** Reads the session cookie, so render it inside Suspense. */
export async function DemoBar() {
  if (!isDemoMode()) return null;
  const session = await getSession();
  return <PersonaSwitcher current={session?.username ?? null} testMoney={moneyIsTest()} judge={await isJudge()} />;
}

export function Brand() {
  return (
    <Link href="/" className="press -ml-1 inline-flex min-h-11 items-center rounded-in px-1 text-xl font-extrabold tracking-tight text-main">
      {APP_NAME}
    </Link>
  );
}

/** Reads the session cookie, so render it inside Suspense. A caretaker's or vet's desk link is in the header, not the menu. */
export async function HeaderSession() {
  const session = await getSession();
  const [me] = session
    ? await db.select({ show: users.showNameInThanks }).from(users).where(eq(users.id, session.userId))
    : [];
  return <SignIn username={session?.username ?? null} showName={me?.show ?? true} />;
}
