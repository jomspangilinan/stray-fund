import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { cats, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { POST as sessionPost } from "../src/app/api/session/route";
import { POST as donationPost } from "../src/app/api/donations/route";
import { POST as capturePost } from "../src/app/api/donations/[orderId]/capture/route";
import { POST as reportPost } from "../src/app/api/spot/report/route";
import { POST as sexPost } from "../src/app/api/cats/[id]/sex/route";
import { POST as earTipPost } from "../src/app/api/cats/[id]/ear-tip/route";
import { POST as namePost } from "../src/app/api/cats/[id]/name/route";
import { POST as anotherNamePost } from "../src/app/api/cats/[id]/another-name/route";
import { ensureDemoPersonas } from "../src/server/demoPersonas";
import { readSession, SESSION_COOKIE, signSession } from "../src/server/session";
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
import { eq } from "drizzle-orm";

// A throwaway value for tests only. The real code lives in the environment and never in the repo.
const CODE = "test-judge-code-0000";
const prod = { NODE_ENV: "production", JUDGE_GATE: "true", JUDGE_PASSCODE: CODE } as unknown as NodeJS.ProcessEnv;

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

  it("lets everyone in when the gate is off, whatever the code or NODE_ENV", () => {
    for (const NODE_ENV of ["production", "test"]) {
      expect(judgeFromCookie(undefined, { NODE_ENV } as unknown as NodeJS.ProcessEnv)).toBe(true);
      expect(judgeFromCookie(undefined, { NODE_ENV, JUDGE_PASSCODE: CODE } as unknown as NodeJS.ProcessEnv)).toBe(true);
      expect(judgeFromCookie(undefined, { NODE_ENV, JUDGE_GATE: "", JUDGE_PASSCODE: CODE } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it("with the gate on, passes only a cookie made with the code, and nobody when no code is set", () => {
    const on = { JUDGE_GATE: "true", JUDGE_PASSCODE: CODE } as unknown as NodeJS.ProcessEnv;
    expect(judgeFromCookie(judgeCookieValue(CODE), on)).toBe(true);
    expect(judgeFromCookie(undefined, on)).toBe(false);
    expect(judgeFromCookie(judgeCookieValue("other-code"), on)).toBe(false);
    expect(judgeFromCookie(judgeCookieValue(""), { JUDGE_GATE: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(judgeFromCookie(undefined, { JUDGE_GATE: "true", JUDGE_PASSCODE: "" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("treats anything but exactly \"true\" as gate off", () => {
    for (const JUDGE_GATE of ["TRUE", "1", "True", " true", "yes"]) {
      expect(judgeFromCookie(undefined, { JUDGE_GATE, JUDGE_PASSCODE: CODE } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
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

describe("judge-only actions", () => {
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ID = "00000000-0000-4000-8000-000000000000";
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  async function signIn(u: { id: string; username: string; role: string }) {
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: u.role as "donor", username: u.username }));
  }
  async function donor() {
    const [u] = await db.insert(users).values({ username: "gate_donor", role: "donor" }).returning();
    await signIn(u);
    return u;
  }
  const asJudge = () => jar.set(JUDGE_COOKIE, judgeCookieValue(CODE));
  const switchTo = (persona: string) => sessionPost(new Request("http://localhost/api/session", json({ persona })));

  beforeEach(async () => {
    await truncateAll();
    jar.clear();
    vi.stubEnv("JUDGE_GATE", "true");
    vi.stubEnv("JUDGE_PASSCODE", CODE);
    vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-1234");
    vi.stubEnv("DEMO_MODE", "true");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(closePool);

  it("keeps the caretaker and vet personas for judges, and leaves the neighbour open", async () => {
    for (const persona of ["caretaker", "vet"]) {
      const res = await switchTo(persona);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: JUDGE_ONLY_LINE });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await switchTo("neighbour")).status).toBe(200);
    asJudge();
    expect((await switchTo("caretaker")).status).toBe(200);
    expect((await switchTo("vet")).status).toBe(200);
  });

  it("reads a staff persona session as signed out without the judge cookie", async () => {
    await ensureDemoPersonas();
    const [staff] = await db.select().from(users).where(eq(users.username, "demo_caretaker"));
    const [neighbour] = await db.select().from(users).where(eq(users.username, "demo_neighbour"));
    const token = (u: typeof staff) => signSession({ userId: u.id, role: u.role as "caretaker", username: u.username });
    expect(await readSession(await token(staff))).toBeNull();
    expect(await readSession(await token(neighbour))).toMatchObject({ username: "demo_neighbour" });
    asJudge();
    expect(await readSession(await token(staff))).toMatchObject({ username: "demo_caretaker", role: "caretaker" });
  });

  it("answers 403 with the one line on donate, capture, report and the cat votes, and lets a judge through", async () => {
    await donor();
    const [cat] = await db.insert(cats).values({ name: "Gate", areaName: "Brgy 1", status: "spotted" }).returning();
    const calls: [string, () => Promise<Response>][] = [
      ["donate", () => donationPost(new Request("http://x/api", json({ amount: 10000, attemptId: ID })))],
      ["capture", () => capturePost(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ orderId: "X" }) })],
      ["report", () => reportPost(new Request("http://x/api", json({ sightingId: ID, claim: "sick" })))],
      ["sex", () => sexPost(new Request("http://x/api", json({ answer: "female" })), ctx(cat.id))],
      ["ear-tip", () => earTipPost(new Request("http://x/api", json({ answer: "yes" })), ctx(cat.id))],
      ["name", () => namePost(new Request("http://x/api", json({ name: "Mimi" })), ctx(cat.id))],
      ["another-name", () => anotherNamePost(new Request("http://x/api", json({})), ctx(cat.id))],
    ];
    for (const [label, call] of calls) {
      const res = await call();
      expect(res.status, label).toBe(403);
      expect(await res.json(), label).toEqual({ error: JUDGE_ONLY_LINE });
    }
    asJudge();
    for (const [label, call] of calls) {
      const res = await call();
      expect(await res.json(), label).not.toEqual({ error: JUDGE_ONLY_LINE });
    }
    const sex = await sexPost(new Request("http://x/api", json({ answer: "female" })), ctx(cat.id));
    expect(sex.status).toBe(200);
  });

  it("still asks a signed-out caller to sign in before it mentions judges", async () => {
    expect((await sexPost(new Request("http://x/api", json({ answer: "female" })), ctx(ID))).status).toBe(401);
  });
});
