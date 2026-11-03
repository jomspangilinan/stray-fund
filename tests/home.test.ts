import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, donations } from "../src/server/db/schema";
import { consoleFor, FUND_PAGES, HELPED_PAGES, isActiveTab, TABS } from "../src/lib/nav";
import { getHomeData } from "../src/server/public";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);
afterAll(closePool);

const EMAIL = "home.sentinel@example.test";

describe("home data", () => {
  it("carries only the whitelisted public fields", async () => {
    const [cat] = await db
      .insert(cats)
      .values({
        name: "Mimi",
        areaName: "Brgy. San Antonio, near the market",
        exactLat: 10.987654321,
        exactLng: 120.123456789,
        fuzzedLat: 10.55555555,
        fuzzedLng: 120.66666666,
      })
      .returning();
    await db.insert(donations).values({ gross: 100_000, paypalFee: 0, net: 100_000, paypalOrderId: "home-1", status: "captured" });
    await db.insert(agentActions).values({
      action: "fund_cat",
      inputs: { catId: cat.id, secret: "agentinputs-sentinel", email: EMAIL },
      reason: "Waited longest",
      amount: 150_000,
      status: "done",
    });
    const home = await getHomeData();
    expect(Object.keys(home).sort()).toEqual(["catCount", "cats", "latestAction", "poolAvailable"]);
    expect(home.poolAvailable).toBe(100_000);
    expect(home.catCount).toBe(1);
    expect(home.latestAction?.cat).toBe("Mimi");
    const text = JSON.stringify(home);
    for (const s of ["10.987654321", "120.123456789", "10.55555555", "exact", "fuzzed", "agentinputs-sentinel", EMAIL]) {
      expect(text, `leaked ${s}`).not.toContain(s);
    }
  });

  it("shows no latest action and a zero pool when there is nothing yet", async () => {
    const home = await getHomeData();
    expect(home).toEqual({ poolAvailable: 0, latestAction: null, cats: [], catCount: 0 });
  });
});

describe("tabs and consoles", () => {
  it("offers the same five tabs to everyone", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Yard", "Cats", "Spot", "Helped", "Fund"]);
    expect(TABS.map((t) => t.href)).toEqual(["/", "/cats", "/spot", "/helped", "/ledger"]);
    expect(TABS[2].key).toBe("spot");
  });

  it("keeps Fund lit on all three money pages and Helped on both of its pages", () => {
    const [, , , helped, fund] = TABS;
    for (const path of ["/ledger", "/agent", "/impact"]) expect(isActiveTab(fund, path)).toBe(true);
    for (const path of ["/helped", "/missions"]) expect(isActiveTab(helped, path)).toBe(true);
    expect(isActiveTab(fund, "/helped")).toBe(false);
    expect(isActiveTab(helped, "/ledger")).toBe(false);
    expect(isActiveTab(fund, "/")).toBe(false);
    expect(FUND_PAGES.map((p) => p.label)).toEqual(["Ledger", "Treasurer", "Proof"]);
    expect(HELPED_PAGES.map((p) => p.label)).toEqual(["Cats I've helped", "Missions"]);
  });

  it("marks Yard only on the home page", () => {
    const home = TABS[0];
    expect(isActiveTab(home, "/")).toBe(true);
    expect(isActiveTab(home, "/cats")).toBe(false);
    expect(isActiveTab(TABS[1], "/cats/12")).toBe(true);
    expect(isActiveTab(TABS[1], "/")).toBe(false);
  });

  it("hands a console link only to caretakers and vets, each their own", () => {
    expect(consoleFor("caretaker")?.href).toBe("/caretaker");
    expect(consoleFor("vet")?.href).toBe("/vet");
    expect(consoleFor("donor")).toBeNull();
    expect(consoleFor("foster")).toBeNull();
    expect(consoleFor(null)).toBeNull();
  });
});

describe("renamed routes", () => {
  it("has no page or api route left at the old paths", () => {
    for (const old of ["src/app/catch", "src/app/collection", "src/app/api/catch"]) {
      expect(existsSync(old), old).toBe(false);
    }
    for (const now of ["src/app/spot/page.tsx", "src/app/helped/page.tsx", "src/app/api/spot/route.ts"]) {
      expect(existsSync(now), now).toBe(true);
    }
  });
});
