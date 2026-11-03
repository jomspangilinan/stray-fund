import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { conservation } from "../src/lib/impact";
import { COLONY } from "../src/lib/config";
import { CAT_STATUSES } from "../src/lib/catState";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, donations, payouts, sightings, treatments, users } from "../src/server/db/schema";
import { FakesInProduction } from "../src/server/e2e/guard";
import { getImpact, getLedger } from "../src/server/impact";
import { getPoolStatus } from "../src/server/ledger";
import { getCatForViewer, listCats } from "../src/server/public";
import { assertSeedAllowed, describeTarget, SAMPLE_PREFIX, SAMPLE_REASON, seed, SeedRefused } from "../src/server/seed";
import { truncateAll } from "./helpers/db";

const run = promisify(execFile);

beforeEach(truncateAll);
afterAll(closePool);

describe("the seed refuses to run by accident", () => {
  const url = "postgres://someone:secret@db.example.test:5432/strayfund";

  it("needs SEED_CONFIRM=yes, and no other value counts", () => {
    for (const value of [undefined, "", "true", "1", "YES", "no"]) {
      expect(() => assertSeedAllowed({ DATABASE_URL: url, SEED_CONFIRM: value })).toThrow(SeedRefused);
    }
    expect(() => assertSeedAllowed({ DATABASE_URL: url, SEED_CONFIRM: "yes" })).not.toThrow();
  });

  it("asks for the same yes in production, and refuses the test fakes there", () => {
    expect(() => assertSeedAllowed({ DATABASE_URL: url, NODE_ENV: "production" })).toThrow(SeedRefused);
    expect(() => assertSeedAllowed({ DATABASE_URL: url, NODE_ENV: "production", SEED_CONFIRM: "yes" })).not.toThrow();
    expect(() => assertSeedAllowed({ DATABASE_URL: url, NODE_ENV: "production", SEED_CONFIRM: "yes", E2E_FAKES: "true" })).toThrow(FakesInProduction);
  });

  it("has nothing to seed without a database", () => {
    expect(() => assertSeedAllowed({ SEED_CONFIRM: "yes" })).toThrow(/DATABASE_URL/);
  });

  it("names the host and database, never the user or password", () => {
    expect(describeTarget(url)).toBe("db.example.test:5432/strayfund");
    expect(describeTarget("postgres://u:p@localhost/strayfund_dev")).toBe("localhost/strayfund_dev");
  });

  it("refuses at the command line without touching the database", async () => {
    await db.insert(users).values({ username: "survivor", role: "donor" });
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL, SEED_CONFIRM: "" };
    await expect(run("node_modules/.bin/tsx", ["scripts/seed.ts"], { env, timeout: 60_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SEED_CONFIRM=yes"),
    });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("prints the target before it writes, then writes only that database", async () => {
    const target = describeTarget(process.env.DATABASE_URL!);
    const env = { ...process.env, SEED_CONFIRM: "yes" };
    const { stdout } = await run("node_modules/.bin/tsx", ["scripts/seed.ts"], { env, timeout: 120_000 });
    expect(stdout).toContain(`Seeding ${target}`);
    expect(stdout).not.toContain("@");
    expect(stdout.indexOf("Seeding")).toBeLessThan(stdout.indexOf("Done"));
    expect((await db.select().from(cats)).length).toBeGreaterThanOrEqual(6);
  });
});

describe("the seeded story", () => {
  beforeEach(async () => {
    await seed();
  });

  it("has 6 to 8 cats covering every status, and 3 to 4 donors beside the demo personas", async () => {
    const all = await db.select().from(cats);
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.length).toBeLessThanOrEqual(8);
    expect(new Set(all.map((c) => c.status))).toEqual(new Set(CAT_STATUSES));
    const people = await db.select({ username: users.username, role: users.role }).from(users);
    const donors = people.filter((p) => p.role === "donor" && p.username !== "demo_neighbour");
    expect(donors.length).toBeGreaterThanOrEqual(3);
    expect(donors.length).toBeLessThanOrEqual(4);
    expect(people.map((p) => p.username)).toEqual(expect.arrayContaining(["demo_neighbour", "demo_caretaker", "demo_vet"]));
  });

  it("has one cat only neighbours call neutered, and one a caretaker confirmed", async () => {
    const all = await db.select().from(cats);
    const say = all.filter((c) => c.neuteredUnconfirmed);
    expect(say.map((c) => [c.name, c.status, c.earTipped])).toEqual([["Puso", "neutered", true]]);
    const caretakerConfirmed = all.filter((c) => c.earTipped === true && !c.neuteredUnconfirmed && c.name === "Tisay");
    expect(caretakerConfirmed).toHaveLength(1);
    expect(caretakerConfirmed[0].status).toBe("adoptable");
  });

  it("does not mark any cat the fund neutered, or any past neutered, as unconfirmed by mistake", async () => {
    const treated = await db.select({ catId: treatments.catId }).from(treatments);
    const paid = await db.select({ catId: payouts.catId }).from(payouts);
    const withRecord = new Set([...treated, ...paid].map((r) => r.catId));
    const all = await db.select().from(cats);
    for (const c of all) {
      if (withRecord.has(c.id)) expect(c.neuteredUnconfirmed, c.name).toBe(false);
      if (c.neuteredUnconfirmed) expect(withRecord.has(c.id), c.name).toBe(false);
    }
    // Only a cat at status neutered can wait on a caretaker.
    expect(all.filter((c) => c.neuteredUnconfirmed && c.status !== "neutered")).toEqual([]);
    // The public list agrees: the unconfirmed cat reads as neighbours say, the rest by their status.
    const labels = Object.fromEntries((await listCats()).map((c) => [c.name, c.statusLabel]));
    expect(labels.Puso).toBe("Neighbours say already neutered");
    expect(labels.Biscoy).toBe("Adopted");
    expect(labels.Tisay).toBe("Ready for a home");
  });

  it("uses invented coordinates near the placeholder centre, and keeps them off the public view", async () => {
    for (const c of await db.select().from(cats)) {
      expect(Math.abs(c.exactLat! - COLONY.centre.lat)).toBeLessThan(0.02);
      expect(Math.abs(c.exactLng! - COLONY.centre.lng)).toBeLessThan(0.02);
      expect([c.fuzzedLat, c.fuzzedLng]).not.toEqual([c.exactLat, c.exactLng]);
      const view = await getCatForViewer(c.id, null);
      expect(JSON.stringify(view)).not.toMatch(/exact|\.\d{4}\d*,/);
      expect(view).not.toHaveProperty("exact");
    }
  });

  it("has no photos, since none is licensed to use: every card shows its look-alike", async () => {
    expect(await db.select().from(sightings)).toEqual([]);
    for (const c of await listCats()) expect(c.photoUrl).toBeNull();
    for (const c of await db.select().from(cats)) expect(c.avatar).not.toBeNull();
  });

  it("labels all sample money as sample, and shows no PayPal id that looks real", async () => {
    const rows = await getLedger();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.paypalId, JSON.stringify(r)).toMatch(new RegExp(`^${SAMPLE_PREFIX}`));
      if (r.reason) expect(r.reason).toMatch(new RegExp(`^${SAMPLE_REASON}`));
    }
    const everyId = [
      ...(await db.select({ id: donations.paypalOrderId, c: donations.paypalCaptureId }).from(donations)).flatMap((d) => [d.id, d.c]),
      ...(await db.select({ b: payouts.paypalPayoutBatchId, i: payouts.paypalItemId }).from(payouts)).flatMap((p) => [p.b, p.i]),
      ...(await db.select({ r: agentActions.paypalRef }).from(agentActions)).map((a) => a.r),
    ].filter((v): v is string => v !== null);
    expect(everyId.length).toBeGreaterThan(0);
    for (const id of everyId) expect(id.startsWith(SAMPLE_PREFIX), id).toBe(true);
    for (const a of await db.select().from(agentActions)) expect(a.reason.startsWith(SAMPLE_REASON), a.action).toBe(true);
  });

  it("adds up to the centavo on the seeded rows alone, and the ledger agrees with the pool", async () => {
    const pool = await db.transaction((tx) => getPoolStatus(tx));
    expect(conservation(pool).balanced).toBe(true);
    expect(pool).toMatchObject({ grossIn: 850_000, paypalFees: 32_150, vetPaid: 165_000, payoutFees: 3_300, reservedPayouts: 0, heldForCats: 405_000, available: 244_550 });
    const impact = await getImpact();
    expect(impact).toMatchObject({ catsNeutered: 1, catsVaccinated: 1, catsDewormed: 1, catsAdopted: 1, alreadyNeutered: 1 });
    const { rows } = await db.execute(sql`select count(*)::int as n from allocations where cat_id is not null`);
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it("leaves the demo accounts a story: the neighbour has given, and the vet can be paid", async () => {
    const [neighbour] = await db.select().from(users).where(eq(users.username, "demo_neighbour"));
    expect(await db.select().from(donations).where(eq(donations.userId, neighbour.id))).toHaveLength(1);
    const [vet] = await db.select().from(users).where(eq(users.username, "demo_vet"));
    expect(vet.clinicName).not.toBeNull();
  });

  it("can be run again: it resets, it does not pile up", async () => {
    await seed();
    expect((await db.select().from(cats)).length).toBe(8);
    expect((await db.select().from(donations)).length).toBe(5);
  });
});
