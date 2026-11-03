import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { register } from "../src/instrumentation";
import { assertBootSafe, DemoWithLivePayPal } from "../src/server/e2e/guard";
import { closePool, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/donate" }));

import { ensureDemoPersonas } from "../src/server/demoPersonas";
import { getSession, requireRole, SESSION_COOKIE, signSession, switchPersona } from "../src/server/session";

const run = promisify(execFile);

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("DEMO_MODE", "true");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

describe("I2: demo mode and live PayPal never run together", () => {
  it("refuses DEMO_MODE=true with live PayPal, whatever the spelling", () => {
    for (const live of ["production", "live", "LIVE", " Production "]) {
      expect(() => assertBootSafe({ DEMO_MODE: "true", PAYPAL_ENV: live })).toThrow(DemoWithLivePayPal);
    }
  });

  it("lets demo run on the sandbox, and live run with the demo off", () => {
    for (const env of ["sandbox", "", undefined]) expect(() => assertBootSafe({ DEMO_MODE: "true", PAYPAL_ENV: env })).not.toThrow();
    expect(() => assertBootSafe({ DEMO_MODE: "false", PAYPAL_ENV: "production" })).not.toThrow();
    expect(() => assertBootSafe({ PAYPAL_ENV: "production" })).not.toThrow();
  });

  it("still refuses the e2e fakes in production", () => {
    expect(() => assertBootSafe({ NODE_ENV: "production", E2E_FAKES: "true" })).toThrow(/E2E_FAKES/);
  });

  it("stops the app at boot", () => {
    vi.stubEnv("PAYPAL_ENV", "production");
    expect(() => register()).toThrow(DemoWithLivePayPal);
  });

  it("stops the worker at boot", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DEMO_MODE: "true", PAYPAL_ENV: "production", E2E_FAKES: "" };
    await expect(run("node_modules/.bin/tsx", ["src/worker/index.ts"], { env, timeout: 60_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("DemoWithLivePayPal"),
    });
  });
});

describe("I2: readSession checks the database", () => {
  async function tokenFor(userId: string, role: "donor" | "caretaker" | "vet", username: string) {
    jar.set(SESSION_COOKIE, await signSession({ userId, role, username }));
  }

  it("takes the role from the users table, not from the token", async () => {
    const [u] = await db.insert(users).values({ username: "plain_donor", role: "donor" }).returning();
    await tokenFor(u.id, "caretaker", "plain_donor");
    expect(await getSession()).toMatchObject({ role: "donor" });
    await expect(requireRole("caretaker")).rejects.toMatchObject({ status: 403 });
  });

  it("follows a role change at once, in both directions", async () => {
    const [u] = await db.insert(users).values({ username: "real_staff", role: "caretaker" }).returning();
    await tokenFor(u.id, "caretaker", "real_staff");
    await expect(requireRole("caretaker")).resolves.toMatchObject({ role: "caretaker" });
    await db.update(users).set({ role: "donor" }).where(eq(users.id, u.id));
    await expect(requireRole("caretaker")).rejects.toMatchObject({ status: 403 });
  });

  it("gives no session for a user who is gone, or an id that is not one", async () => {
    await tokenFor("00000000-0000-4000-8000-000000000000", "caretaker", "ghost_user");
    expect(await getSession()).toBeNull();
    await tokenFor("not-a-uuid", "caretaker", "ghost_user");
    expect(await getSession()).toBeNull();
  });

  it("rejects a persona session once DEMO_MODE is off, for every persona", async () => {
    for (const key of ["neighbour", "caretaker", "vet"] as const) {
      const s = await switchPersona(key);
      jar.set(SESSION_COOKIE, await signSession(s));
      expect(await getSession()).toMatchObject({ username: s.username });
      vi.stubEnv("DEMO_MODE", "false");
      expect(await getSession()).toBeNull();
      await expect(requireRole("caretaker", "vet", "donor")).rejects.toMatchObject({ status: 401 });
      vi.stubEnv("DEMO_MODE", "true");
    }
  });

  it("keeps real caretakers signed in when DEMO_MODE is off", async () => {
    await ensureDemoPersonas();
    const [u] = await db.insert(users).values({ username: "marites_staff", role: "caretaker" }).returning();
    vi.stubEnv("DEMO_MODE", "false");
    await tokenFor(u.id, "caretaker", "marites_staff");
    await expect(requireRole("caretaker")).resolves.toMatchObject({ role: "caretaker", username: "marites_staff" });
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DonateForm } from "../src/components/DonateForm";
import { moneyIsTest } from "../src/lib/config";
import { testMoneyLine } from "../src/lib/moneyCopy";

describe("I2: 'Test money only' is only said when it is true", () => {
  it("moneyIsTest follows PAYPAL_ENV", () => {
    for (const v of [undefined, "", "sandbox"]) {
      vi.stubEnv("PAYPAL_ENV", v ?? "");
      expect(moneyIsTest()).toBe(true);
    }
    for (const v of ["production", "live", " LIVE "]) {
      vi.stubEnv("PAYPAL_ENV", v);
      expect(moneyIsTest()).toBe(false);
    }
  });

  it("the donate form says test money only with test money, and not with live money", () => {
    const draw = (testMoney: boolean) =>
      renderToStaticMarkup(createElement(DonateForm, { clientId: "x", username: "someone", testMoney }));
    expect(draw(true)).toContain("Test money only");
    expect(draw(false)).not.toMatch(/test money|sandbox/i);
    const out = renderToStaticMarkup(createElement(DonateForm, { clientId: "x", username: null, testMoney: false }));
    expect(out).not.toMatch(/test money|sandbox/i);
  });

  it("shared lines drop the claim when the money is live", () => {
    expect(testMoneyLine(true)).toMatch(/test money/i);
    expect(testMoneyLine(false)).toBe("");
  });
});
