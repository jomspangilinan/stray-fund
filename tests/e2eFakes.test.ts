import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../src/instrumentation";
import { runAgent } from "../src/server/agent/run";
import { assessPhoto } from "../src/server/ai/assess";
import { readReceipt } from "../src/server/ai/receipt";
import { treasurerClient } from "../src/server/ai/subscription";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, users } from "../src/server/db/schema";
import { assertE2eFakesSafe, e2eFakesEnabled, FakesInProduction } from "../src/server/e2e/guard";
import { fakeDonationFee, fakeOrdersGateway, fakePayoutFee, fakePayoutGateway, fakeVerifyWebhook, FAKE_SIGNATURE } from "../src/server/e2e/paypal";
import { captureDonation, createDonationOrder, ordersGateway, sdkOrdersGateway } from "../src/server/paypal/orders";
import { payoutGateway, restPayoutGateway } from "../src/server/paypal/payouts";
import { verifyWebhook } from "../src/server/paypal/webhook";
import { truncateAll } from "./helpers/db";

const run = promisify(execFile);

beforeEach(truncateAll);
afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

describe("E2E_FAKES is refused in production", () => {
  it("throws for any value of E2E_FAKES on a production server", () => {
    for (const value of ["true", "false", "1", "yes"]) {
      expect(() => assertE2eFakesSafe({ NODE_ENV: "production", E2E_FAKES: value })).toThrow(FakesInProduction);
    }
  });

  it("lets production start when E2E_FAKES is unset or empty, and lets other environments use it", () => {
    expect(() => assertE2eFakesSafe({ NODE_ENV: "production" })).not.toThrow();
    expect(() => assertE2eFakesSafe({ NODE_ENV: "production", E2E_FAKES: "" })).not.toThrow();
    expect(() => assertE2eFakesSafe({ NODE_ENV: "development", E2E_FAKES: "true" })).not.toThrow();
    expect(() => assertE2eFakesSafe({ E2E_FAKES: "true" })).not.toThrow();
  });

  it("is also refused when PAYPAL_ENV is live, whatever NODE_ENV says (the worker runs under tsx and may have no NODE_ENV)", () => {
    for (const live of ["production", "live", "LIVE", " Production "]) {
      expect(() => assertE2eFakesSafe({ PAYPAL_ENV: live, E2E_FAKES: "true" })).toThrow(FakesInProduction);
      expect(() => assertE2eFakesSafe({ NODE_ENV: "development", PAYPAL_ENV: live, E2E_FAKES: "true" })).toThrow(FakesInProduction);
      expect(() => e2eFakesEnabled({ PAYPAL_ENV: live, E2E_FAKES: "true" })).toThrow(FakesInProduction);
    }
    for (const safe of [undefined, "", "sandbox"]) {
      expect(() => assertE2eFakesSafe({ PAYPAL_ENV: safe, E2E_FAKES: "true" })).not.toThrow();
    }
    expect(() => assertE2eFakesSafe({ PAYPAL_ENV: "live" })).not.toThrow();
  });

  it("is on only for the exact value true", () => {
    expect(e2eFakesEnabled({ E2E_FAKES: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "1", "TRUE"]) expect(e2eFakesEnabled({ E2E_FAKES: value })).toBe(false);
  });

  it("stops the app at boot: Next calls register() once when the server starts", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKES", "true");
    expect(() => register()).toThrow(FakesInProduction);
    vi.stubEnv("E2E_FAKES", "");
    expect(() => register()).not.toThrow();
  });

  it("stops the worker at boot", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", E2E_FAKES: "true" };
    await expect(run("node_modules/.bin/tsx", ["src/worker/index.ts"], { env, timeout: 60_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("FakesInProduction"),
    });
  });

  it("leaves no way round it: every fake seam refuses on a production server", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKES", "true");
    expect(() => ordersGateway()).toThrow(FakesInProduction);
    expect(() => payoutGateway()).toThrow(FakesInProduction);
    await expect(verifyWebhook(new Headers({ "paypal-transmission-sig": FAKE_SIGNATURE }), "{}")).rejects.toThrow(FakesInProduction);
    expect(() => treasurerClient({ NODE_ENV: "production", E2E_FAKES: "true" })).toThrow(FakesInProduction);
    const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toBuffer();
    // The vision call reports the service as unavailable rather than answering from the fake.
    expect(await assessPhoto(photo)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the fakes sit at the real seams and only when asked", () => {
  it("uses the real PayPal gateways when E2E_FAKES is off", () => {
    expect(ordersGateway()).toBe(sdkOrdersGateway);
    expect(payoutGateway()).toBe(restPayoutGateway);
  });

  it("uses the fakes when it is on", () => {
    vi.stubEnv("E2E_FAKES", "true");
    expect(ordersGateway()).toBe(fakeOrdersGateway);
    expect(payoutGateway()).toBe(fakePayoutGateway);
  });

  it("does not let a fake signature past the real webhook check when the fakes are off", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const headers = new Headers({
      "paypal-auth-algo": "x",
      "paypal-cert-url": "x",
      "paypal-transmission-id": "x",
      "paypal-transmission-time": "x",
      "paypal-transmission-sig": FAKE_SIGNATURE,
    });
    expect(await verifyWebhook(headers, "{}")).toBe(false);
    expect(fakeVerifyWebhook(headers)).toBe(true);
    headers.set("paypal-transmission-sig", "forged");
    expect(fakeVerifyWebhook(headers)).toBe(false);
    headers.set("paypal-transmission-sig", FAKE_SIGNATURE);
    headers.delete("paypal-cert-url");
    expect(fakeVerifyWebhook(headers)).toBe(false);
  });

  it("charges the stand-in fees in whole centavos", () => {
    expect(fakeDonationFee(10_000)).toBe(1_790);
    expect(fakeDonationFee(150_000)).toBe(5_850);
    expect(fakePayoutFee(45_000)).toBe(900);
    expect(fakePayoutFee(75_000)).toBe(1_500);
    expect(fakePayoutFee(10_000_000)).toBe(5_000);
  });

  it("makes a donation the real code records to the centavo", async () => {
    vi.stubEnv("E2E_FAKES", "true");
    const [donor] = await db.insert(users).values({ username: "fake_donor", role: "donor" }).returning();
    const { orderId } = await createDonationOrder(donor.id, 150_000, "11111111-2222-4333-8444-555555555555");
    expect(orderId).toMatch(/^E2E-ORDER-150000-[0-9a-f]{8}$/);
    const d = await captureDonation(donor.id, orderId);
    expect(d).toMatchObject({ status: "captured", gross: 150_000, paypalFee: 5_850, net: 144_150 });
    expect(d.paypalCaptureId).toMatch(/^E2E-CAPTURE-/);
    // A second capture of the same order changes nothing.
    expect(await captureDonation(donor.id, orderId)).toMatchObject({ id: d.id, net: 144_150 });
  });

  it("gives the same batch for the same sender batch id, so a retry cannot pay twice", async () => {
    const input = { senderBatchId: "11111111-1111-4111-8111-111111111111", receiver: "vet@e2e.invalid", amount: 45_000, note: "n" };
    const a = await fakePayoutGateway.create(input);
    const b = await fakePayoutGateway.create(input);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: "sent", batchId: expect.stringMatching(/^E2E-BATCH-45000-/) });
    if (a.kind !== "sent") throw new Error("unreachable");
    expect(await fakePayoutGateway.get(a.batchId)).toMatchObject({ batchStatus: "SUCCESS", itemStatus: "SUCCESS", fee: 900 });
  });
});

describe("the fake AI", () => {
  const picture = (width: number) => sharp({ create: { width, height: 40, channels: 3, background: "#eee" } }).jpeg().toBuffer();

  it("describes a photo as a tabby and picks a name that is not taken", async () => {
    vi.stubEnv("E2E_FAKES", "true");
    const first = await assessPhoto(await picture(64));
    expect(first).toMatchObject({ ok: true, data: { is_cat: true, suggested_name: "Mocha", sensitive_regions: [] } });
    const second = await assessPhoto(await picture(64), ["Mocha", "tikoy"]);
    expect(second).toMatchObject({ ok: true, data: { suggested_name: "Biscoy" } });
  });

  it("reads a receipt as a receipt for as many pesos as the picture is wide", async () => {
    vi.stubEnv("E2E_FAKES", "true");
    const res = await readReceipt(await picture(1200));
    expect(res).toMatchObject({ ok: true, data: { total_centavos: 120_000, currency: "PHP", tamper_signs: [] } });
  });

  async function queuedCat(name: string, createdAt: Date) {
    const [c] = await db.insert(cats).values({ name, areaName: "Brgy 1", status: "queued", queuedAt: createdAt, createdAt }).returning();
    return c;
  }
  async function gift(net: number) {
    const [d] = await db
      .insert(donations)
      .values({ gross: net + 1_000, paypalFee: 1_000, net, paypalOrderId: `E2E-ORDER-${net}-${net}`, status: "captured" })
      .returning();
    return d;
  }
  const wake = { kind: "donation_captured", payload: {} };

  it("as the treasurer, funds the first waiting cat through the real tool when the pool covers it", async () => {
    vi.stubEnv("E2E_FAKES", "true");
    const first = await queuedCat("Mocha", new Date(Date.now() - 2 * 86_400_000));
    await queuedCat("Tikoy", new Date(Date.now() - 86_400_000));
    await gift(150_000);
    const result = await runAgent(wake, { client: treasurerClient(), loadToolkit: async () => [] });
    expect(result).toMatchObject({ stop: "end_turn", actions: ["fund_next_cat"] });
    expect((await db.select().from(cats)).map((c) => [c.name, c.status]).sort()).toEqual([["Mocha", "funded"], ["Tikoy", "queued"]]);
    expect((await db.select().from(allocations))[0]).toMatchObject({ catId: first.id, amount: 150_000 });
  });

  it("as the treasurer, waits when the pool is short, and funds nothing", async () => {
    vi.stubEnv("E2E_FAKES", "true");
    await queuedCat("Mocha", new Date());
    await gift(149_999);
    const result = await runAgent(wake, { client: treasurerClient(), loadToolkit: async () => [] });
    expect(result).toMatchObject({ stop: "end_turn", actions: [] });
    expect((await db.select().from(cats))[0].status).toBe("queued");
  });
});
