import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JUDGE_COOKIE,
  JUDGE_ONLY_LINE,
  JUDGE_UNTIL,
  JudgeOnly,
  codeMatches,
  judgeCookieValue,
  judgeFromCookie,
} from "../src/server/judge";
import { GET } from "../src/app/judge/route";

// A throwaway value for tests only. The real code lives in the environment and never in the repo.
const CODE = "test-judge-code-0000";
const prod = { NODE_ENV: "production", JUDGE_PASSCODE: CODE } as NodeJS.ProcessEnv;

const visit = (query: string) => GET(new Request(`http://localhost/judge${query}`));

describe("judge cookie", () => {
  it("accepts only a value made with the current code", () => {
    const good = judgeCookieValue(CODE);
    expect(judgeFromCookie(good, prod)).toBe(true);
    expect(judgeFromCookie(judgeCookieValue("other-code"), prod)).toBe(false);
    const flipped = (good[0] === "A" ? "B" : "A") + good.slice(1);
    expect(judgeFromCookie(flipped, prod)).toBe(false);
    expect(judgeFromCookie(undefined, prod)).toBe(false);
    expect(judgeFromCookie("", prod)).toBe(false);
  });

  it("lets nobody in on production without a code, and everyone in outside production", () => {
    expect(judgeFromCookie(undefined, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(judgeFromCookie(judgeCookieValue(""), { NODE_ENV: "production", JUDGE_PASSCODE: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(judgeFromCookie(undefined, { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
    expect(judgeFromCookie(undefined, { NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    // Outside production a set code still gates, so a local run can rehearse the judge link.
    expect(judgeFromCookie(undefined, { NODE_ENV: "development", JUDGE_PASSCODE: CODE } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("matches the code exactly", () => {
    expect(codeMatches(CODE, CODE)).toBe(true);
    expect(codeMatches(` ${CODE}`, CODE)).toBe(false);
    expect(codeMatches(CODE.toUpperCase(), CODE)).toBe(false);
    expect(codeMatches(null, CODE)).toBe(false);
    expect(codeMatches("x", undefined)).toBe(false);
    expect(codeMatches("", "")).toBe(false);
  });

  it("refuses with the one line the app shows", () => {
    expect(new JudgeOnly().message).toBe(JUDGE_ONLY_LINE);
    expect(JUDGE_ONLY_LINE).toBe("Open to judges during the hackathon.");
  });
});

describe("GET /judge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sets the signed cookie for the right code and sends the judge home without the code", async () => {
    vi.stubEnv("JUDGE_PASSCODE", CODE);
    const res = await visit(`?code=${CODE}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("/");
    expect(location).not.toContain(CODE);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${JUDGE_COOKIE}=${judgeCookieValue(CODE)}`);
    expect(cookie).not.toContain(CODE);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Expires=${JUDGE_UNTIL.toUTCString()}`);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("sets nothing for a wrong, padded or missing code", async () => {
    vi.stubEnv("JUDGE_PASSCODE", CODE);
    for (const q of ["?code=wrong", `?code=%20${CODE}`, "", "?code="]) {
      const res = await visit(q);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("sets nothing when no code is configured", async () => {
    vi.stubEnv("JUDGE_PASSCODE", "");
    const res = await visit("?code=");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
