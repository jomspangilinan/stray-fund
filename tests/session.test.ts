import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { allowedPayees, cats, donations, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { makeDonor, makePendingOrder } from "./helpers/donationFixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { POST as sessionPost, DELETE as sessionDelete } from "../src/app/api/session/route";
import { POST as capturePost } from "../src/app/api/donations/[orderId]/capture/route";
import { POST as donationPost } from "../src/app/api/donations/route";
import { ensureDemoPersonas } from "../src/server/demoPersonas";
import { GET as catGet } from "../src/app/api/cats/[id]/route";
import { POST as caretakerPost } from "../src/app/api/caretaker/[action]/route";
import { DEMO_ROLES } from "../src/lib/demoRoles";
import {
  AuthError,
  getSession,
  requireRole,
  SESSION_COOKIE,
  signSession,
  validateUsername,
} from "../src/server/session";

const post = (body: unknown) =>
  sessionPost(
    new Request("http://localhost/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

function cookieValue(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header)?.[1] ?? "";
}

/** Plays the browser: keeps the cookie a response set. */
function keepCookie(res: Response) {
  jar.set(SESSION_COOKIE, cookieValue(res));
}

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("PAYPAL_VET_EMAIL", "vet@example.test");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

describe("sign in", () => {
  it("a new username creates a donor only", async () => {
    const res = await post({ username: "Maria_01" });
    expect(res.status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.username, "Maria_01"));
    expect(u.role).toBe("donor");
    keepCookie(res);
    expect(await getSession()).toEqual({ userId: u.id, role: "donor", username: "Maria_01" });
  });

  it("a request body cannot set the role", async () => {
    const res = await post({ username: "sneaky_1", role: "vet" });
    expect(res.status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.username, "sneaky_1"));
    expect(u.role).toBe("donor");
    keepCookie(res);
    expect((await getSession())?.role).toBe("donor");
  });

  it("matches usernames ignoring case instead of creating a duplicate", async () => {
    await post({ username: "Maria_01" });
    const res = await post({ username: "maria_01" });
    expect(res.status).toBe(200);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("two simultaneous first sign-ins make one user", async () => {
    const [a, b] = await Promise.all([post({ username: "racer_1" }), post({ username: "RACER_1" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it.each(["ab", "a".repeat(21), "has space", "dash-name", "emoji😀", "", "admin", "Admin", "demo_vet", "DEMO_x1"])(
    "rejects username %j",
    async (name) => {
      const res = await post({ username: name });
      expect(res.status).toBe(403);
      expect(await db.select().from(users)).toHaveLength(0);
    },
  );

  it("cannot sign in as a staff account by typing its name", async () => {
    await ensureDemoPersonas();
    const res = await post({ username: "demo_vet" });
    expect(res.status).toBe(403);
    expect(cookieValue(res)).toBe("");
  });

  it("validateUsername accepts 3 and 20 characters", () => {
    expect(validateUsername("abc").ok).toBe(true);
    expect(validateUsername("a".repeat(20)).ok).toBe(true);
  });

  it("sets an httpOnly, lax cookie, and secure in production", async () => {
    const dev = (await post({ username: "cookie_1" })).headers.get("set-cookie")!;
    expect(dev).toMatch(/HttpOnly/i);
    expect(dev).toMatch(/SameSite=lax/i);
    expect(dev).not.toMatch(/Secure/i);
    vi.stubEnv("NODE_ENV", "production");
    const prod = (await post({ username: "cookie_1" })).headers.get("set-cookie")!;
    expect(prod).toMatch(/Secure/i);
  });

  it("sign out clears the cookie", async () => {
    const res = await sessionDelete();
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });
});

describe("session token", () => {
  it("a tampered or foreign token gives no session", async () => {
    const token = await signSession({ userId: "u", role: "vet", username: "x_x" });
    jar.set(SESSION_COOKIE, token.slice(0, -2) + "xx");
    expect(await getSession()).toBeNull();
    vi.stubEnv("SESSION_SECRET", "another-secret-another-secret-another-1");
    jar.set(SESSION_COOKIE, token);
    expect(await getSession()).toBeNull();
  });

  it("refuses to sign without a long enough SESSION_SECRET", async () => {
    vi.stubEnv("SESSION_SECRET", "short");
    await expect(signSession({ userId: "u", role: "donor", username: "x_x" })).rejects.toThrow(/SESSION_SECRET/);
  });

  it("requireRole gives 401 signed out and 403 for the wrong role", async () => {
    await expect(requireRole("vet")).rejects.toMatchObject({ status: 401 });
    keepCookie(await post({ username: "plain_1" }));
    await expect(requireRole("vet")).rejects.toBeInstanceOf(AuthError);
    await expect(requireRole("vet")).rejects.toMatchObject({ status: 403 });
    await expect(requireRole("donor", "vet")).resolves.toMatchObject({ role: "donor" });
  });
});

describe("persona switching", () => {
  it("is refused when DEMO_MODE=false", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const res = await post({ persona: "vet" });
    expect(res.status).toBe(403);
    expect(cookieValue(res)).toBe("");
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("switches to the seeded caretaker and vet in demo mode", async () => {
    const res = await post({ persona: "vet" });
    expect(res.status).toBe(200);
    keepCookie(res);
    expect(await getSession()).toMatchObject({ role: "vet", username: "demo_vet" });
    keepCookie(await post({ persona: "caretaker" }));
    expect(await getSession()).toMatchObject({ role: "caretaker", username: "demo_caretaker" });
  });

  it("rejects an unknown persona and a role-shaped key", async () => {
    expect((await post({ persona: "admin" })).status).toBe(400);
    expect((await post({ persona: "toString" })).status).toBe(400);
  });

  it("ensureDemoPersonas is idempotent and seeds the vet payee", async () => {
    await ensureDemoPersonas();
    await ensureDemoPersonas();
    await Promise.all([ensureDemoPersonas(), ensureDemoPersonas()]);
    const all = await db.select().from(users);
    expect(all.map((u) => u.username).sort()).toEqual(["demo_caretaker", "demo_neighbour", "demo_vet"]);
    const vet = all.find((u) => u.username === "demo_vet")!;
    expect(vet).toMatchObject({ role: "vet", paypalEmail: "vet@example.test" });
    expect(all.find((u) => u.username === "demo_caretaker")!.role).toBe("caretaker");
    const payees = await db.select().from(allowedPayees);
    expect(payees).toEqual([{ userId: vet.id, kind: "vet" }]);
  });
});

describe("demo neighbour", () => {
  it("is not available when DEMO_MODE is off", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const res = await post({ persona: "neighbour" });
    expect(res.status).toBe(403);
    expect(cookieValue(res)).toBe("");
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("is an ordinary donor with no desk access", async () => {
    keepCookie(await post({ persona: "neighbour" }));
    expect(await getSession()).toMatchObject({ role: "donor", username: "demo_neighbour" });
    await expect(requireRole("caretaker")).rejects.toMatchObject({ status: 403 });
    await expect(requireRole("vet")).rejects.toMatchObject({ status: 403 });
    const res = await caretakerPost(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      { params: Promise.resolve({ action: "approve-name" }) },
    );
    expect(res.status).toBe(403);
  });

  it("sees no exact location on a cat", async () => {
    const [cat] = await db
      .insert(cats)
      .values({ name: "Mimi", areaName: "Brgy. San Antonio, near the market", exactLat: 10.987654321, exactLng: 120.123456789, fuzzedLat: 10.5, fuzzedLng: 120.6 })
      .returning();
    keepCookie(await post({ persona: "neighbour" }));
    const res = await catGet(new Request("http://localhost/x"), { params: Promise.resolve({ id: cat.id }) });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("10.987654321");
    expect(text).not.toContain("120.123456789");
  });

  it("the roles strip's Neighbour is the one-tap way into the demo, as an ordinary neighbour with no desk", async () => {
    expect(DEMO_ROLES.map((r) => r.key)).toEqual(["neighbour", "caretaker", "vet"]);
    keepCookie(await post({ persona: "neighbour" }));
    expect((await getSession())?.role).toBe("donor");
  });
});

describe("donation routes", () => {
  it("capture returns 403 for an order that belongs to someone else", async () => {
    const owner = await makeDonor();
    const { orderId } = await makePendingOrder(owner.id);
    keepCookie(await post({ username: "intruder_1" }));
    const res = await capturePost(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ orderId }),
    });
    expect(res.status).toBe(403);
    expect((await db.select().from(donations))[0].status).toBe("pending");
  });

  it("capture and create need a session", async () => {
    const c = await capturePost(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ orderId: "X" }),
    });
    expect(c.status).toBe(401);
    const d = await donationPost(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ amount: 10_000 }) }),
    );
    expect(d.status).toBe(401);
  });

  it("create returns 429 after 5 pending orders in 10 minutes", async () => {
    const res = await post({ username: "spammer_1" });
    keepCookie(res);
    const session = await getSession();
    for (let i = 0; i < 5; i++) await makePendingOrder(session!.userId);
    const out = await donationPost(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ amount: 10_000, attemptId: crypto.randomUUID() }) }),
    );
    expect(out.status).toBe(429);
  });

  it("create rejects a missing or malformed attempt id with 400 before calling PayPal", async () => {
    keepCookie(await post({ username: "giver_2" }));
    for (const attemptId of [undefined, "", "not-a-uuid", 7]) {
      const res = await donationPost(
        new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ amount: 10_000, attemptId }) }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("create rejects a bad amount with 400 before calling PayPal", async () => {
    keepCookie(await post({ username: "giver_1" }));
    for (const amount of [5_000, 100.5, "100"]) {
      const res = await donationPost(
        new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ amount }) }),
      );
      expect(res.status).toBe(400);
    }
  });
});
