import { NextResponse } from "next/server";
import { JUDGE_COOKIE, JUDGE_UNTIL, codeMatches, judgeCookieValue } from "@/server/judge";

/**
 * The judge link. A right code sets the signed judge cookie; any other visit just goes home.
 * Either way the reply is the same redirect, with no code in it, so the address bar loses the code.
 */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code");
  const passcode = process.env.JUDGE_PASSCODE;
  const res = new NextResponse(null, {
    status: 303,
    headers: { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  if (passcode && codeMatches(code, passcode)) {
    res.cookies.set(JUDGE_COOKIE, judgeCookieValue(passcode), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: JUDGE_UNTIL,
    });
  }
  return res;
}
