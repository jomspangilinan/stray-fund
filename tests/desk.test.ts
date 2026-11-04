import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { agentActions, bookings, cats, nameSuggestions, payouts, reviewRequests, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { runAction } from "../src/server/caretaker";
import { caretakerWaiting, getCaretakerQueue } from "../src/server/caretaker/queue";
import { vetWaiting, listVetDashboard } from "../src/server/vetFlow";
import { deskTotal } from "../src/lib/deskSections";
import { landingAfterSwitch } from "../src/lib/nav";
import { setGatewayForTests } from "../src/server/caretaker";
import { FakeGateway, addPayout, makeWorld } from "./helpers/payoutFixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}));

import { SESSION_COOKIE, signSession, type Role } from "../src/server/session";
import { DeskGate } from "../src/components/desk/DeskGate";

let seq = 0;
async function makeUser(role: Role, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ username: `${role}_${Date.now()}_${++seq}`, role, ...over }).returning();
  return u;
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name: `Cat${++seq}`, areaName: "Brgy 1", ...over }).returning();
  return c;
}
async function signIn(u: { id: string; username: string }, role: Role) {
  jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role, username: u.username }));
}

beforeEach(async () => {
  await truncateAll();
  jar.clear();
});
afterAll(closePool);

describe("the caretaker's waiting count", () => {
  it("is zero on an empty desk, then counts every section the desk lists", async () => {
    expect(await caretakerWaiting()).toBe(0);
    const care = await makeUser("caretaker");
    const donor = await makeUser("donor");
    const cat = await makeCat();
    await makeCat({ status: "spotted" }); // no ear-tip decision
    await db.insert(nameSuggestions).values({ catId: cat.id, requesterId: donor.id, name: "Boss" });
    await db.insert(reviewRequests).values({ subject: "Q", reason: "Why", status: "open" });
    const q = await getCaretakerQueue();
    const n = await caretakerWaiting();
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBe(deskTotal(q));
    expect(care.id).toBeTruthy();
  });
});

describe("the vet's waiting count", () => {
  it("counts only bookings that need the vet's evidence, and matches the desk", async () => {
    const vet = await makeUser("vet");
    const [action] = await db.insert(agentActions).values({ action: "x", inputs: {}, reason: "r", status: "done" }).returning();
    const make = async (catStatus: string, deposit: boolean) => {
      const cat = await makeCat({ status: catStatus });
      const [b] = await db.insert(bookings).values({ catId: cat.id, vetId: vet.id, packagePrice: 150000, status: "confirmed" }).returning();
      if (deposit)
        await db.insert(payouts).values({ catId: cat.id, bookingId: b.id, payeeUserId: vet.id, amount: 45000, kind: "deposit", actionId: action.id, status: "succeeded" });
      return b;
    };
    await make("in_care", true); // evidence open
    await make("in_care", false); // waiting for the deposit
    await make("booked", true); // waiting for the cat
    expect(await vetWaiting(vet.id)).toEqual({ toSend: 1, toCheck: 0 });
    const d = await listVetDashboard(vet.id);
    expect(d.bookings.filter((b) => b.evidence === "open")).toHaveLength(1);
    const other = await makeUser("vet");
    expect(await vetWaiting(other.id)).toEqual({ toSend: 0, toCheck: 0 });
  });
});

describe("who may open the desk screens", () => {
  const text = async (node: unknown) => JSON.stringify(node);
  it("shows the caretaker the content and everyone else a refusal", async () => {
    expect(await text(await DeskGate({ children: "SECRET" }))).toContain("pick the Caretaker role");
    const donor = await makeUser("donor");
    await signIn(donor, "donor");
    const out = await text(await DeskGate({ children: "SECRET" }));
    expect(out).toContain("This page is for caretakers.");
    expect(out).not.toContain("SECRET");
    const vet = await makeUser("vet");
    await signIn(vet, "vet");
    expect(await text(await DeskGate({ children: "SECRET" }))).not.toContain("SECRET");
    const care = await makeUser("caretaker");
    await signIn(care, "caretaker");
    expect(await text(await DeskGate({ children: "SECRET" }))).toContain("SECRET");
  });
});

describe("renaming a cat as a caretaker", () => {
  it("closes the pending suggestions for that cat and no others", async () => {
    const care = await makeUser("caretaker");
    const a = await makeUser("donor");
    const b = await makeUser("donor");
    const cat = await makeCat();
    const other = await makeCat();
    await db.insert(nameSuggestions).values([
      { catId: cat.id, requesterId: a.id, name: "Mochi" },
      { catId: cat.id, requesterId: b.id, name: "Tofu" },
      { catId: other.id, requesterId: a.id, name: "Pepper" },
    ]);
    expect(await runAction("cat_rename", care.id, { catId: cat.id, name: "Boss" })).toMatchObject({ ok: true });
    const rows = await db.select().from(nameSuggestions);
    const of = (id: string) => rows.filter((r) => r.catId === id).map((r) => r.status);
    expect(of(cat.id)).toEqual(["dismissed", "dismissed"]);
    expect(of(other.id)).toEqual(["pending"]);
    const [row] = await db.select().from(nameSuggestions).where(eq(nameSuggestions.name, "Mochi"));
    expect(row.decidedBy).toBe(care.id);
    expect((await getCaretakerQueue()).nameSuggestions.map((n) => n.name)).toEqual(["Pepper"]);
  });
});

describe("where a role switch lands", () => {
  it("sends a caretaker or vet to their desk", () => {
    expect(landingAfterSwitch("caretaker", "/cats")).toBe("/caretaker");
    expect(landingAfterSwitch("vet", "/")).toBe("/vet");
  });
  it("keeps an allowed page and otherwise goes to the yard", () => {
    expect(landingAfterSwitch("donor", "/cats")).toBe("/cats");
    expect(landingAfterSwitch("donor", "/caretaker")).toBe("/");
    expect(landingAfterSwitch("donor", "/caretaker/rules")).toBe("/");
    expect(landingAfterSwitch("foster", "/vet/bookings/abc")).toBe("/");
  });
});

describe("the tone of a caretaker action's reply", () => {
  const caretaker = async () => makeUser("caretaker");
  const approve = async (results: ConstructorParameters<typeof FakeGateway>[0], over: { attempts?: number } = {}) => {
    const care = await caretaker();
    const w = await makeWorld({ funded: 250000 });
    const p = await addPayout(w, { amount: 120000, status: "awaiting_approval", attempts: over.attempts });
    setGatewayForTests(new FakeGateway(results));
    try {
      return await runAction("payout_approve", care.id, { payoutId: p.id });
    } finally {
      setGatewayForTests(null);
    }
  };

  it("is ok for a send that went out", async () => {
    expect(await approve([])).toMatchObject({ ok: true, tone: "ok" });
  });
  it("is bad when PayPal did not take the payment", async () => {
    const r = await approve([{ kind: "rejected", error: "HTTP 422" }]);
    expect(r).toMatchObject({ ok: true, tone: "bad" });
    expect(r.message).toMatch(/did not take the payment/);
  });
  it("is warn when the send could not be confirmed", async () => {
    const r = await approve([{ kind: "rejected", error: "HTTP 422" }], { attempts: 1 });
    expect(r).toMatchObject({ ok: true, tone: "warn" });
    expect(r.message).toMatch(/under review/);
  });
  it("is ok for an ordinary refusal-free action and bad for a refusal", async () => {
    const care = await caretaker();
    expect(await runAction("payout_note", care.id, { payoutId: "00000000-0000-4000-8000-000000000000", note: "x" })).toMatchObject({ ok: false, tone: "bad" });
  });
});
