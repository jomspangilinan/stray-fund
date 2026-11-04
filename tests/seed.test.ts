import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conservation } from "../src/lib/impact";
import { COLONY } from "../src/lib/config";
import { CAT_STATUSES } from "../src/lib/catState";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, donations, payouts, reports, sightings, treatments, users } from "../src/server/db/schema";
import { FakesInProduction } from "../src/server/e2e/guard";
import { getImpact, getLedger } from "../src/server/impact";
import { getPoolStatus } from "../src/server/ledger";
import { getCatForViewer, getPriorityList, listCats } from "../src/server/public";
import { catTimeline } from "../src/server/timeline";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { heldCatIds } from "../src/server/reports";
import { isSampleSightingKey } from "../src/server/demoPrivacy";
import { assertNoRealLedger, assertSeedAllowed, describeTarget, SAMPLE_PREFIX, SAMPLE_REASON, seed, SeedRefused } from "../src/server/seed";
import { truncateAll } from "./helpers/db";

const demoOn = () => vi.stubEnv("DEMO_MODE", "true");

const run = promisify(execFile);

beforeEach(truncateAll);
afterAll(closePool);

describe("the seed refuses to run by accident", () => {
  const url = "postgres://someone:secret@db.example.test:5432/strayfund";
  const demo = { DEMO_MODE: "true", PAYPAL_ENV: "sandbox" };

  it("needs SEED_CONFIRM=yes, and no other value counts", () => {
    for (const value of [undefined, "", "true", "1", "YES", "no"]) {
      expect(() => assertSeedAllowed({ ...demo, DATABASE_URL: url, SEED_CONFIRM: value })).toThrow(SeedRefused);
    }
    expect(() => assertSeedAllowed({ ...demo, DATABASE_URL: url, SEED_CONFIRM: "yes" })).not.toThrow();
  });

  it("asks for the same yes in production, and refuses the test fakes there", () => {
    expect(() => assertSeedAllowed({ ...demo, DATABASE_URL: url, NODE_ENV: "production" })).toThrow(SeedRefused);
    expect(() => assertSeedAllowed({ ...demo, DATABASE_URL: url, NODE_ENV: "production", SEED_CONFIRM: "yes" })).not.toThrow();
    expect(() => assertSeedAllowed({ ...demo, DATABASE_URL: url, NODE_ENV: "production", SEED_CONFIRM: "yes", E2E_FAKES: "true" })).toThrow(FakesInProduction);
  });

  it("seeds only a demo: DEMO_MODE must be true and PayPal must not be live, because the seed leaves a confirmed booking and a queued cat the worker would act on", () => {
    const ok = { DATABASE_URL: url, SEED_CONFIRM: "yes", DEMO_MODE: "true" };
    expect(() => assertSeedAllowed(ok)).not.toThrow();
    expect(() => assertSeedAllowed({ ...ok, PAYPAL_ENV: "sandbox" })).not.toThrow();
    for (const mode of [undefined, "", "false", "1", "TRUE"]) {
      expect(() => assertSeedAllowed({ ...ok, DEMO_MODE: mode })).toThrow(/DEMO_MODE/);
    }
    for (const live of ["production", "live", "LIVE"]) {
      expect(() => assertSeedAllowed({ ...ok, PAYPAL_ENV: live })).toThrow(/PAYPAL_ENV/);
    }
  });

  it("has nothing to seed without a database", () => {
    expect(() => assertSeedAllowed({ ...demo, SEED_CONFIRM: "yes" })).toThrow(/DATABASE_URL/);
  });

  it("names the host and database, never the user or password", () => {
    expect(describeTarget(url)).toBe("db.example.test:5432/strayfund");
    expect(describeTarget("postgres://u:p@localhost/strayfund_dev")).toBe("localhost/strayfund_dev");
  });

  it("refuses at the command line without touching the database", async () => {
    await db.insert(users).values({ username: "survivor", role: "donor" });
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL, SEED_CONFIRM: "", DEMO_MODE: "true", PAYPAL_ENV: "sandbox" };
    await expect(run("node_modules/.bin/tsx", ["scripts/seed.ts"], { env, timeout: 60_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SEED_CONFIRM=yes"),
    });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("prints the target before it writes, then writes only that database", async () => {
    const target = describeTarget(process.env.DATABASE_URL!);
    const env = { ...process.env, SEED_CONFIRM: "yes", DEMO_MODE: "true", PAYPAL_ENV: "sandbox" };
    const { stdout } = await run("node_modules/.bin/tsx", ["scripts/seed.ts"], { env, timeout: 120_000 });
    expect(stdout).toContain(`Seeding ${target}`);
    expect(stdout).not.toContain("@");
    expect(stdout.indexOf("Seeding")).toBeLessThan(stdout.indexOf("Done"));
    expect((await db.select().from(cats)).length).toBeGreaterThanOrEqual(6);
  });
});

describe("the seed will not wipe a real ledger", () => {
  /** Seeds a sample story, then makes one row look like it came from PayPal. */
  const withRealOrder = async (id: string) => {
    await seed({});
    const [d] = await db.select().from(donations).limit(1);
    await db.update(donations).set({ paypalOrderId: id }).where(eq(donations.id, d.id));
  };
  const withRealBatch = async (id: string) => {
    await seed({});
    const [p] = await db.select().from(payouts).limit(1);
    await db.update(payouts).set({ paypalPayoutBatchId: id }).where(eq(payouts.id, p.id));
  };

  it("passes on an empty database, and on sample rows and E2E- rows", async () => {
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await seed({});
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    const [d] = await db.select().from(donations).limit(1);
    await db.update(donations).set({ paypalOrderId: "E2E-ORDER-1500-abcd1234" }).where(eq(donations.id, d.id));
    const [p] = await db.select().from(payouts).limit(1);
    await db.update(payouts).set({ paypalPayoutBatchId: "E2E-BATCH-450-x" }).where(eq(payouts.id, p.id));
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await expect(seed({})).resolves.toMatchObject({ cats: 11 });
  });

  it("counts a payout with no batch id as real, unless its action is marked as sample", async () => {
    await seed({});
    const [p] = await db.select().from(payouts).limit(1);
    await db.update(payouts).set({ paypalPayoutBatchId: null }).where(eq(payouts.id, p.id));
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await expect(seed({})).resolves.toMatchObject({ cats: 11 });

    await seed({});
    const [q] = await db.select().from(payouts).limit(1);
    await db.update(payouts).set({ paypalPayoutBatchId: null }).where(eq(payouts.id, q.id));
    await db.update(agentActions).set({ reason: "Caretaker approved the balance for a vet." }).where(eq(agentActions.id, q.actionId));
    const before = (await db.select().from(payouts)).length;
    await expect(assertNoRealLedger({})).rejects.toThrow(SeedRefused);
    await expect(seed({})).rejects.toThrow(SeedRefused);
    expect(await db.select().from(payouts)).toHaveLength(before);
    expect((await db.select().from(payouts)).some((r) => r.id === q.id && r.paypalPayoutBatchId === null)).toBe(true);
  });

  it("refuses when a donation order id is not SAMPLE- or E2E-, and leaves the data alone", async () => {
    await withRealOrder("5O190127TN364715T");
    await expect(assertNoRealLedger({})).rejects.toThrow(SeedRefused);
    await expect(seed({})).rejects.toThrow(/SEED_WIPE_REAL=yes/);
    expect(await db.select().from(donations)).toHaveLength(5);
    expect((await db.select().from(cats)).length).toBe(11);
  });

  it("refuses when a payout batch id is not SAMPLE- or E2E-", async () => {
    await withRealBatch("PAYOUT-REAL-BATCH");
    await expect(assertNoRealLedger({})).rejects.toThrow(SeedRefused);
    await expect(seed({})).rejects.toThrow(SeedRefused);
    expect((await db.select().from(payouts)).some((p) => p.paypalPayoutBatchId === "PAYOUT-REAL-BATCH")).toBe(true);
  });

  it("treats lowercase sample- as real, and only SEED_WIPE_REAL=yes overrides", async () => {
    await withRealOrder("sample-1");
    for (const v of [undefined, "", "true", "1", "YES"]) await expect(assertNoRealLedger({ SEED_WIPE_REAL: v })).rejects.toThrow(SeedRefused);
    await expect(assertNoRealLedger({ SEED_WIPE_REAL: "yes" })).resolves.toBeUndefined();
    await expect(seed({ SEED_WIPE_REAL: "yes" })).resolves.toMatchObject({ cats: 11 });
    expect((await db.select().from(donations)).every((d) => d.paypalOrderId.startsWith(SAMPLE_PREFIX))).toBe(true);
  });
});

describe("the seeded story", () => {
  beforeEach(async () => {
    await seed();
  });

  it("has 6 to 12 cats covering every status, and 3 to 4 donors beside the demo personas", async () => {
    const all = await db.select().from(cats);
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.length).toBeLessThanOrEqual(12);
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

  it("has no public photos, since none is licensed to use: every card shows its look-alike", async () => {
    // The only sightings are the drawn stand-ins behind the three reports, and none is public.
    const all = await db.select().from(sightings);
    expect(all).toHaveLength(3);
    for (const s of all) expect([s.publicReady, s.publicKey]).toEqual([false, null]);
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
    expect(impact).toMatchObject({ catsNeutered: 2, catsNeuteredByFund: 1, catsVaccinated: 1, catsDewormed: 1, catsAdopted: 1, alreadyNeutered: 1 });
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
    expect((await db.select().from(cats)).length).toBe(11);
    expect((await db.select().from(donations)).length).toBe(5);
  });
});

describe("the seeded report story", () => {
  beforeEach(async () => {
    await seed();
  });
  afterEach(() => vi.unstubAllEnvs());

  const byName = async () => Object.fromEntries((await db.select().from(cats)).map((c) => [c.name, c]));

  it("has an open hurt report, a confirmed one waiting on the vet, a dismissed one, and a plain waiting list", async () => {
    const c = await byName();
    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.sample && r.source === "neighbour" && r.reporterId && r.sightingId)).toBe(true);
    const of = (name: string) => rows.find((r) => r.catId === c[name].id)!;
    expect(of("Hapon")).toMatchObject({ claim: "injured", status: "open", decidedBy: null });
    expect(of("Bituin")).toMatchObject({ claim: "injured", status: "confirmed" });
    expect(of("Bituin").decidedBy).not.toBeNull();
    expect(of("Dilaw")).toMatchObject({ claim: "sick", status: "dismissed" });

    // A neighbour's claim is not a fact: only the caretaker-confirmed one is a flag.
    expect(c.Hapon.flags).toEqual([]);
    expect(c.Bituin.flags).toEqual(["injured"]);
    expect(c.Dilaw.flags).toEqual([]);
    const held = await db.transaction((tx) => heldCatIds(tx));
    expect([...held].sort()).toEqual([c.Hapon.id, c.Bituin.id].sort());

    const list = await getPriorityList();
    expect(list.needsPerson.map((r) => r.name).sort()).toEqual(["Bituin", "Hapon"]);
    expect(list.nextToFund.map((r) => r.name)).toEqual(["Mingming", "Dilaw"]);
  });

  it("writes no treasurer decision about any of it", async () => {
    const acts = await db.select({ action: agentActions.action }).from(agentActions);
    expect(acts.map((a) => a.action)).not.toEqual(expect.arrayContaining(["set_cat_place"]));
    for (const a of acts) expect(["set_cat_place", "ask_for_check", "caretaker_review"]).not.toContain(a.action);
    expect((await db.select({ q: reports.checkQuestion }).from(reports)).every((r) => r.q === null)).toBe(true);
  });

  it("uses invented notes: no digits, no capitalised names, no addresses", async () => {
    for (const r of await db.select().from(reports)) {
      expect(r.note).toBeTruthy();
      expect(r.note).not.toMatch(/\d|@|\b(street|st\.|road|rd\.|brgy|barangay|house)\b/i);
      expect(r.note!.replace(/(^|[.!?]\s+)[A-Z]/g, "$1x")).not.toMatch(/[A-Z]/);
    }
  });

  it("shows the seeded note on the demo desk, and serves the sample photo there", async () => {
    demoOn();
    const queue = await getCaretakerQueue();
    expect(queue.reports).toHaveLength(1);
    expect(queue.reports[0]).toMatchObject({ catName: "Hapon", claim: "injured", source: "neighbour" });
    expect(queue.reports[0].note).toMatch(/Limping/);
    const [s] = await db.select().from(sightings).where(eq(sightings.id, queue.reports[0].sightingId!));
    expect(isSampleSightingKey(s.originalKey)).toBe(true);
  });

  it("keeps every other stored key out of the sample-photo rule", () => {
    expect(isSampleSightingKey("originals/3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b.jpg")).toBe(false);
    expect(isSampleSightingKey("originals/00000000-0000-4000-8000-000000000001.jpg")).toBe(true);
    expect(isSampleSightingKey("originals/00000000-0000-4000-8000-000000000001.jpg/../x")).toBe(false);
  });

  it("gives each reported cat a timeline of what happened, with the dismissal in plain words", async () => {
    const c = await byName();
    const titles = async (n: string) => (await catTimeline(c[n].id)).map((e) => e.title);
    expect(await titles("Hapon")).toContain("Neighbour reported hurt");
    expect(await titles("Bituin")).toContain("Caretaker confirmed he's hurt");
    expect(await titles("Dilaw")).toContain("A caretaker checked this report and closed it.");
  });
});
