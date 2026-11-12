import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conservation } from "../src/lib/impact";
import { COLONY } from "../src/lib/config";
import { closePool, db } from "../src/server/db/client";
import { agentActions, bookings, cats, donations, payouts, reports, sightings, treatments, users } from "../src/server/db/schema";
import { FakesInProduction } from "../src/server/e2e/guard";
import { getImpact, getLedger } from "../src/server/impact";
import { getPoolStatus } from "../src/server/ledger";
import { getCatForViewer, getPriorityList, listCats } from "../src/server/public";
import { catTimeline } from "../src/server/timeline";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { heldCatIds } from "../src/server/reports";
import { isSampleSightingKey } from "../src/server/demoPrivacy";
import { assertNoRealLedger, assertSeedAllowed, describeTarget, SAMPLE_PREFIX, seed, SeedRefused } from "../src/server/seed";
import { SAMPLE_REASON } from "../src/server/demoPrivacy";
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
  // The seed writes no money, so each test adds the rows it needs.
  const addDonation = async (orderId: string) => {
    const [u] = await db.select().from(users).where(eq(users.username, "demo_neighbour"));
    await db.insert(donations).values({ userId: u.id, gross: 50_000, paypalFee: 2_950, net: 47_050, currency: "PHP", paypalOrderId: orderId, paypalCaptureId: `${orderId}-C`, status: "captured" });
  };
  const addPayout = async (batch: string | null, reason = `${SAMPLE_REASON}The vet visit was confirmed, so the deposit went out.`) => {
    // One open booking per cat, so each payout takes a cat without one.
    const booked = new Set((await db.select({ id: bookings.catId }).from(bookings)).map((r) => r.id));
    const c = (await db.select().from(cats)).find((x) => !booked.has(x.id))!;
    const [vet] = await db.select().from(users).where(eq(users.username, "demo_vet"));
    const [b] = await db.insert(bookings).values({ catId: c.id, vetId: vet.id, packagePrice: 150_000, status: "confirmed", scheduledFor: new Date() }).returning();
    const [a] = await db.insert(agentActions).values({ action: "payout_deposit", reason, amount: 45_000, status: "succeeded", paypalRef: batch, inputs: { sample: true } }).returning();
    const [p] = await db
      .insert(payouts)
      .values({ catId: c.id, bookingId: b.id, payeeUserId: vet.id, amount: 45_000, fee: 900, kind: "deposit", paypalPayoutBatchId: batch, actionId: a.id, status: "succeeded", attempts: 1 })
      .returning();
    return p;
  };

  it("passes on an empty database, and on sample rows and E2E- rows", async () => {
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await seed({});
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await addDonation(`${SAMPLE_PREFIX}ORDER-1`);
    await addDonation("E2E-ORDER-1500-abcd1234");
    await addPayout(`${SAMPLE_PREFIX}BATCH-1`);
    await addPayout("E2E-BATCH-450-x");
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await expect(seed({})).resolves.toMatchObject({ cats: 7 });
  });

  it("counts a payout with no batch id as real, unless its action is marked as sample", async () => {
    await seed({});
    await addPayout(null);
    await expect(assertNoRealLedger({})).resolves.toBeUndefined();
    await expect(seed({})).resolves.toMatchObject({ cats: 7 });

    const q = await addPayout(null, "Caretaker approved the balance for a vet.");
    const before = (await db.select().from(payouts)).length;
    await expect(assertNoRealLedger({})).rejects.toThrow(SeedRefused);
    await expect(seed({})).rejects.toThrow(SeedRefused);
    expect(await db.select().from(payouts)).toHaveLength(before);
    expect((await db.select().from(payouts)).some((r) => r.id === q.id && r.paypalPayoutBatchId === null)).toBe(true);
  });

  it("refuses when a donation order id is not SAMPLE- or E2E-, and leaves the data alone", async () => {
    await seed({});
    await addDonation("5O190127TN364715T");
    await expect(assertNoRealLedger({})).rejects.toThrow(SeedRefused);
    await expect(seed({})).rejects.toThrow(/SEED_WIPE_REAL=yes/);
    expect(await db.select().from(donations)).toHaveLength(1);
    expect((await db.select().from(cats)).length).toBe(7);
  });

  it("refuses when a payout batch id is not SAMPLE- or E2E-", async () => {
    await seed({});
    await addPayout("PAYOUT-REAL-BATCH");
    await expect(assertNoRealLedger({})).rejects.toThrow(SeedRefused);
    await expect(seed({})).rejects.toThrow(SeedRefused);
    expect((await db.select().from(payouts)).some((p) => p.paypalPayoutBatchId === "PAYOUT-REAL-BATCH")).toBe(true);
  });

  it("treats lowercase sample- as real, and only SEED_WIPE_REAL=yes overrides", async () => {
    await seed({});
    await addDonation("sample-1");
    for (const v of [undefined, "", "true", "1", "YES"]) await expect(assertNoRealLedger({ SEED_WIPE_REAL: v })).rejects.toThrow(SeedRefused);
    await expect(assertNoRealLedger({ SEED_WIPE_REAL: "yes" })).resolves.toBeUndefined();
    await expect(seed({ SEED_WIPE_REAL: "yes" })).resolves.toMatchObject({ cats: 7 });
    expect(await db.select().from(donations)).toHaveLength(0);
  });
});

describe("the seeded story", () => {
  beforeEach(async () => {
    await seed();
  });

  it("has only the seven real cats, two waiting and the rest spotted, and 3 to 4 donors beside the demo personas", async () => {
    const all = await db.select().from(cats);
    expect(all.map((c) => c.name).sort()).toEqual(["Kislap", "Leo", "Lily", "Milo", "Oliver", "Oreo", "Teddy"]);
    expect(all.filter((c) => c.status === "queued").map((c) => c.name).sort()).toEqual(["Kislap", "Milo"]);
    expect(all.filter((c) => c.status !== "queued").every((c) => c.status === "spotted")).toBe(true);
    const people = await db.select({ username: users.username, role: users.role }).from(users);
    const donors = people.filter((p) => p.role === "donor" && p.username !== "demo_neighbour");
    expect(donors.length).toBeGreaterThanOrEqual(3);
    expect(donors.length).toBeLessThanOrEqual(4);
    expect(people.map((p) => p.username)).toEqual(expect.arrayContaining(["demo_neighbour", "demo_caretaker", "demo_vet"]));
  });

  it("calls no real cat neutered, ear-tipped or treated, since none of that happened", async () => {
    const all = await db.select().from(cats);
    for (const c of all) expect([c.name, c.neuteredUnconfirmed, c.earTipped === true]).toEqual([c.name, false, false]);
    expect(await db.select().from(treatments)).toHaveLength(0);
    expect(await db.select().from(bookings)).toHaveLength(0);
    const labels = Object.fromEntries((await listCats()).map((c) => [c.name, c.statusLabel]));
    expect(labels.Leo).toBe("Spotted");
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

  it("publishes a photo only for the seven real cats, from files that carry no metadata", async () => {
    const REAL = ["Kislap", "Leo", "Lily", "Milo", "Oliver", "Oreo", "Teddy"];
    const all = await db.select().from(sightings);
    // One drawn stand-in behind the one report, private; one real photo per real cat, public.
    expect(all).toHaveLength(1 + REAL.length);
    const drawn = all.filter((s) => isSampleSightingKey(s.originalKey));
    expect(drawn).toHaveLength(1);
    for (const s of drawn) expect([s.publicReady, s.publicKey]).toEqual([false, null]);
    for (const s of all.filter((x) => !isSampleSightingKey(x.originalKey))) expect([s.publicReady, s.publicKey !== null]).toEqual([true, true]);
    const shown = (await listCats()).filter((c) => c.photoUrl).map((c) => c.name).sort();
    expect(shown).toEqual(REAL);
    for (const c of await db.select().from(cats)) expect(c.avatar).not.toBeNull();
    for (const f of await readdir(path.join(process.cwd(), "scripts", "seed-photos"))) {
      const meta = await sharp(path.join(process.cwd(), "scripts", "seed-photos", f)).metadata();
      expect([f, meta.exif, meta.xmp, meta.iptc]).toEqual([f, undefined, undefined, undefined]);
    }
  });

  it("writes no money, so every ledger row will be a real sandbox transaction", async () => {
    expect(await getLedger()).toHaveLength(0);
    expect(await db.select().from(donations)).toHaveLength(0);
    expect(await db.select().from(payouts)).toHaveLength(0);
    for (const a of await db.select().from(agentActions)) expect(a.paypalRef, a.action).toBeNull();
    const pool = await db.transaction((tx) => getPoolStatus(tx));
    expect(conservation(pool).balanced).toBe(true);
    expect(pool).toMatchObject({ grossIn: 0, paypalFees: 0, vetPaid: 0, heldForCats: 0, available: 0 });
    expect(await getImpact()).toMatchObject({ catsNeutered: 0, catsAdopted: 0 });
    const [vet] = await db.select().from(users).where(eq(users.username, "demo_vet"));
    expect(vet.clinicName).not.toBeNull();
  });

  it("can be run again: it resets, it does not pile up", async () => {
    await seed();
    expect((await db.select().from(cats)).length).toBe(7);
    expect((await db.select().from(donations)).length).toBe(0);
  });
});

describe("the seeded report story", () => {
  beforeEach(async () => {
    await seed();
  });
  afterEach(() => vi.unstubAllEnvs());

  const byName = async () => Object.fromEntries((await db.select().from(cats)).map((c) => [c.name, c]));

  it("has one open hurt report and a plain waiting list", async () => {
    const c = await byName();
    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.sample && r.source === "neighbour" && r.reporterId && r.sightingId)).toBe(true);
    const of = (name: string) => rows.find((r) => r.catId === c[name].id)!;
    expect(of("Milo")).toMatchObject({ claim: "injured", status: "open", decidedBy: null });

    // A neighbour's claim is not a fact: only the caretaker-confirmed one is a flag.
    expect(c.Milo.flags).toEqual([]);
    const held = await db.transaction((tx) => heldCatIds(tx));
    expect([...held]).toEqual([c.Milo.id]);

    const list = await getPriorityList();
    expect(list.needsPerson.map((r) => r.name)).toEqual(["Milo"]);
    expect(list.nextToFund.map((r) => r.name)).toEqual(["Kislap"]);
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
    expect(queue.reports[0]).toMatchObject({ catName: "Milo", claim: "injured", source: "neighbour" });
    expect(queue.reports[0].note).toMatch(/Limping/);
    const [s] = await db.select().from(sightings).where(eq(sightings.id, queue.reports[0].sightingId!));
    expect(isSampleSightingKey(s.originalKey)).toBe(true);
  });

  it("keeps every other stored key out of the sample-photo rule", () => {
    expect(isSampleSightingKey("originals/3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b.jpg")).toBe(false);
    expect(isSampleSightingKey("originals/00000000-0000-4000-8000-000000000001.jpg")).toBe(true);
    expect(isSampleSightingKey("originals/00000000-0000-4000-8000-000000000001.jpg/../x")).toBe(false);
  });

  it("gives the reported cat a timeline of what happened", async () => {
    const c = await byName();
    const titles = async (n: string) => (await catTimeline(c[n].id)).map((e) => e.title);
    expect(await titles("Milo")).toContain("Neighbour reported hurt");
  });
});
