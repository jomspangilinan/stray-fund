import { NextResponse } from "next/server";
import { JudgeOnly } from "@/server/judge";
import {
  AuthError,
  getSession,
  isPersonaKey,
  SESSION_COOKIE,
  sessionCookieOptions,
  signInDonor,
  signSession,
  switchPersona,
  type Session,
} from "@/server/session";

async function withCookie(session: Session): Promise<NextResponse> {
  const res = NextResponse.json({ session });
  res.cookies.set(SESSION_COOKIE, await signSession(session), sessionCookieOptions());
  return res;
}

export async function GET() {
  return NextResponse.json({ session: await getSession() });
}

/**
 * Body is {username} to sign in as a donor, or {persona} to switch in demo mode.
 * A role is never read from the body.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body" }, { status: 400 });
  }
  const { username, persona } = (body ?? {}) as { username?: unknown; persona?: unknown };
  try {
    if (persona !== undefined) {
      if (!isPersonaKey(persona)) {
        return NextResponse.json({ error: "Unknown persona" }, { status: 400 });
      }
      return await withCookie(await switchPersona(persona));
    }
    return await withCookie(await signInDonor(username));
  } catch (e) {
    if (e instanceof JudgeOnly) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("Session request failed", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ session: null });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
