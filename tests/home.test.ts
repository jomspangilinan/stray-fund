import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, donations } from "../src/server/db/schema";
import { consoleFor, TABS } from "../src/lib/nav";
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
    expect(TABS.map((t) => t.label)).toEqual(["Cats", "Ledger", "Spot", "Helped", "Treasurer"]);
    expect(TABS.map((t) => t.href)).toEqual(["/cats", "/ledger", "/spot", "/helped", "/agent"]);
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
