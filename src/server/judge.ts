import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { JUDGE_ONLY_LINE } from "@/lib/judgeLine";

/*
 * The private judge link. Judges open /judge?code=<JUDGE_PASSCODE> once; the route sets a signed cookie
 * that lasts until judging ends (Devpost rules, section 4 "Testing": a private site is allowed when the
 * login is in the testing instructions, and access must last until the Judging Period ends on Dec 15).
 *
 * The cookie holds an HMAC of a fixed label keyed by the code, never the code itself, so changing the code
 * signs every judge out. The gate is switched by JUDGE_GATE: unless it is exactly "true", everyone gets the
 * full app. With the gate on and no code set, nobody is a judge.
 */

export const JUDGE_COOKIE = "sf_judge";
export const JUDGE_UNTIL = new Date("2026-12-16T00:00:00Z");
export { JUDGE_ONLY_LINE };
const LABEL = "stray-fund-judge-v1";

export class JudgeOnly extends Error {
  constructor() {
    super(JUDGE_ONLY_LINE);
    this.name = "JudgeOnly";
  }
}

export function judgeCookieValue(passcode: string): string {
  return createHmac("sha256", passcode).update(LABEL).digest("base64url");
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time, exact comparison. An unset or empty code never matches anything. */
export function codeMatches(given: string | null, passcode: string | undefined): boolean {
  if (!passcode || !given) return false;
  return timingSafeEqual(digest(given), digest(passcode));
}

export function judgeFromCookie(value: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  // The gate is off unless JUDGE_GATE is exactly "true", whatever the passcode or NODE_ENV.
  if (env.JUDGE_GATE !== "true") return true;
  const passcode = env.JUDGE_PASSCODE;
  if (!passcode || !value) return false;
  return timingSafeEqual(digest(value), digest(judgeCookieValue(passcode)));
}

export async function isJudge(): Promise<boolean> {
  return judgeFromCookie((await cookies()).get(JUDGE_COOKIE)?.value);
}

export async function requireJudge(): Promise<void> {
  if (!(await isJudge())) throw new JudgeOnly();
}
