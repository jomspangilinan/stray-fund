import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db, withColonyLock } from "../src/server/db/client";
import { allocations, bookings, cats, donations } from "../src/server/db/schema";
import { checkSpend, type SpendRequest } from "../src/server/guardrails";
import { truncateAll } from "./helpers/db";
import {
  addPayout,
  addReceipt,
  depositRequest,
  fundCat,
  makeBooking,
  makeVet,
  makeWorld,
  setGuardrails,
  type World,
} from "./helpers/payoutFixtures";

const check = (r: SpendRequest, opts?: Parameters<typeof checkSpend>[2]) =>
  withColonyLock((tx) => checkSpend(tx, r, opts));

const denied = (code: string) =>
  expect.objectContaining({ verdict: "deny", code, message: expect.any(String) });

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

describe("checkSpend", () => {
  let w: World;

  beforeEach(async () => {
    await truncateAll();
    w = await makeWorld();
  });
  afterAll(async () => {
    await closePool();
  });

  /** A cat has one open booking, so a test giving it a new vet closes the world's first. */
  const retireWorldBooking = () => db.update(bookings).set({ status: "completed" }).where(eq(bookings.id, w.booking.id));

  it("allows a valid deposit", async () => {
    expect(await check(depositRequest(w))).toEqual({ verdict: "allow" });
  });

  it("refuses a non-positive or fractional amount outright", async () => {
    await expect(check(depositRequest(w, 0))).rejects.toThrow(/amount/i);
    await expect(check(depositRequest(w, -1))).rejects.toThrow(/amount/i);
    await expect(check(depositRequest(w, 10.5))).rejects.toThrow(/amount/i);
  });

  describe("approval threshold", () => {
    it("needs approval only strictly above the threshold", async () => {
      expect(await check(depositRequest(w, 200000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w, 200001))).toEqual({ verdict: "needs_approval" });
    });

    it("runs deny checks first", async () => {
      const other = await makeVet();
      expect(await check({ ...depositRequest(w, 200001), payeeId: other.id })).toEqual(
        denied("PAYEE_NOT_ALLOWED"),
      );
      expect(await check(depositRequest(w, 250001))).toEqual(denied("OVER_CAT_CAP"));
    });
  });

  describe("BOOKING_NOT_CONFIRMED", () => {
    it("denies a missing booking", async () => {
      expect(await check({ ...depositRequest(w), bookingId: MISSING_ID })).toEqual(
        denied("BOOKING_NOT_CONFIRMED"),
      );
    });

    it("denies a booking belonging to another cat", async () => {
      const [other] = await db
        .insert(cats)
        .values({ name: "Other", areaName: "Brgy 1" })
        .returning();
      const booking = await makeBooking(other.id, w.vet.id);
      expect(await check({ ...depositRequest(w), bookingId: booking.id })).toEqual(
        denied("BOOKING_NOT_CONFIRMED"),
      );
    });

    it("denies a booking that is not confirmed", async () => {
      const booking = await makeBooking(w.cat.id, w.vet.id, "pending");
      expect(await check({ ...depositRequest(w), bookingId: booking.id })).toEqual(
        denied("BOOKING_NOT_CONFIRMED"),
      );
    });
  });

  describe("PAYEE_NOT_ALLOWED", () => {
    it("denies a vet with no allowed_payees row", async () => {
      const vet = await makeVet({ allowed: false });
      await retireWorldBooking();
      const booking = await makeBooking(w.cat.id, vet.id);
      expect(
        await check({ ...depositRequest(w), payeeId: vet.id, bookingId: booking.id }),
      ).toEqual(denied("PAYEE_NOT_ALLOWED"));
    });

    it("denies an allowed payee who is not the booking's vet", async () => {
      const other = await makeVet();
      expect(await check({ ...depositRequest(w), payeeId: other.id })).toEqual(
        denied("PAYEE_NOT_ALLOWED"),
      );
    });

    it("denies an allowed vet with no PayPal email to pay", async () => {
      const vet = await makeVet({ email: null });
      await retireWorldBooking();
      const booking = await makeBooking(w.cat.id, vet.id);
      expect(
        await check({ ...depositRequest(w), payeeId: vet.id, bookingId: booking.id }),
      ).toEqual(denied("PAYEE_NOT_ALLOWED"));
    });
  });

  describe("DUPLICATE_PAYOUT", () => {
    it.each(["awaiting_approval", "queued", "sent", "succeeded", "needs_review"])(
      "denies when a %s payout exists for the booking and kind",
      async (status) => {
        await addPayout(w, { amount: 100, status });
        expect(await check(depositRequest(w))).toEqual(denied("DUPLICATE_PAYOUT"));
      },
    );

    it.each(["failed", "rejected"])("allows a new payout after a %s one", async (status) => {
      await addPayout(w, { amount: 100, status });
      expect(await check(depositRequest(w))).toEqual({ verdict: "allow" });
    });
  });

  describe("balance", () => {
    const balance = (receiptId?: string): SpendRequest => ({
      ...depositRequest(w),
      amount: 105000,
      kind: "balance",
      receiptId,
    });

    it("allows with a succeeded deposit and a verified receipt for this booking", async () => {
      await addPayout(w, { amount: 45000, status: "succeeded" });
      const receipt = await addReceipt(w.booking.id);
      expect(await check(balance(receipt.id))).toEqual({ verdict: "allow" });
    });

    it.each([[false], [null]])("denies a verified receipt when ear_tipped is %s", async (earTipped) => {
      await addPayout(w, { amount: 45000, status: "succeeded" });
      const receipt = await addReceipt(w.booking.id);
      await db.update(cats).set({ earTipped }).where(eq(cats.id, w.cat.id));
      expect(await check(balance(receipt.id))).toEqual(denied("EAR_TIP_NOT_CONFIRMED"));
    });

    it("does not ask a deposit for a confirmed ear-tip", async () => {
      expect(await check(depositRequest(w))).toEqual({ verdict: "allow" });
    });

    it("denies without a receipt", async () => {
      await addPayout(w, { amount: 45000, status: "succeeded" });
      expect(await check(balance())).toEqual(denied("RECEIPT_NOT_VERIFIED"));
      expect(await check(balance(MISSING_ID))).toEqual(denied("RECEIPT_NOT_VERIFIED"));
    });

    it.each(["pending", "rejected", "needs_review"])("denies a %s receipt", async (state) => {
      await addPayout(w, { amount: 45000, status: "succeeded" });
      const receipt = await addReceipt(w.booking.id, state);
      expect(await check(balance(receipt.id))).toEqual(denied("RECEIPT_NOT_VERIFIED"));
    });

    it("denies a verified receipt for another booking", async () => {
      await addPayout(w, { amount: 45000, status: "succeeded" });
      const otherBooking = await makeBooking(w.cat.id, w.vet.id, "completed");
      const receipt = await addReceipt(otherBooking.id);
      expect(await check(balance(receipt.id))).toEqual(denied("RECEIPT_NOT_VERIFIED"));
    });

    it.each(["queued", "sent", "needs_review", "failed"])(
      "denies when the deposit is only %s",
      async (status) => {
        await addPayout(w, { amount: 45000, status });
        const receipt = await addReceipt(w.booking.id);
        expect(await check(balance(receipt.id))).toEqual(denied("DEPOSIT_NOT_PAID"));
      },
    );

    it("denies when the deposit that succeeded was for another booking", async () => {
      const otherBooking = await makeBooking(w.cat.id, w.vet.id, "completed");
      await addPayout({ ...w, booking: otherBooking }, { amount: 45000, status: "succeeded" });
      const receipt = await addReceipt(w.booking.id);
      expect(await check(balance(receipt.id))).toEqual(denied("DEPOSIT_NOT_PAID"));
    });
  });

  describe("OVER_CAT_CAP", () => {
    it("adds this cat's live payouts to the amount, inclusive at the cap", async () => {
      await fundCat(w.cat.id, 1000000);
      const other = await makeBooking(w.cat.id, w.vet.id, "completed");
      await addPayout({ ...w, booking: other }, { amount: 100000, status: "succeeded" });
      expect(await check(depositRequest(w, 150000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w, 150001))).toEqual(denied("OVER_CAT_CAP"));
    });

    it("ignores failed and rejected payouts", async () => {
      const a = await makeBooking(w.cat.id, w.vet.id, "completed");
      const b = await makeBooking(w.cat.id, w.vet.id, "completed");
      await addPayout({ ...w, booking: a }, { amount: 240000, status: "failed" });
      await addPayout({ ...w, booking: b }, { amount: 240000, status: "rejected" });
      expect(await check(depositRequest(w, 200000))).toEqual({ verdict: "allow" });
    });
  });

  describe("OVER_DAY_CAP", () => {
    it("counts only payouts from the current Asia/Manila date, across a UTC day boundary", async () => {
      // Manila is UTC+8 with no DST. A Manila day starts at 16:00 UTC. Whatever
      // the time now, one of these two rows sits across a UTC date line from
      // the Manila answer, so a UTC-date implementation always fails this test.
      const DAY = 86_400_000;
      const OFFSET = 8 * 3_600_000;
      const manilaMidnight =
        Math.floor((Date.now() + OFFSET) / DAY) * DAY - OFFSET;

      const w2 = await makeWorld();
      const w3 = await makeWorld();
      await addPayout(w2, {
        amount: 500000,
        status: "succeeded",
        createdAt: new Date(manilaMidnight - 1000),
      });
      await addPayout(w3, {
        amount: 100000,
        status: "succeeded",
        createdAt: new Date(manilaMidnight + 1000),
      });
      await setGuardrails({ maxPerDay: 145000 });

      expect(await check(depositRequest(w, 45000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w, 45001))).toEqual(denied("OVER_DAY_CAP"));
    });

    it("counts a payout on its last attempt's day, not the day it was created", async () => {
      const w2 = await makeWorld();
      const w3 = await makeWorld();
      const longAgo = new Date(Date.now() - 3 * 86_400_000);
      await addPayout(w2, {
        amount: 100000,
        status: "sent",
        createdAt: longAgo,
        lastAttemptAt: new Date(),
      });
      await addPayout(w3, {
        amount: 500000,
        status: "sent",
        createdAt: new Date(),
        lastAttemptAt: longAgo,
      });
      await setGuardrails({ maxPerDay: 145000 });
      expect(await check(depositRequest(w, 45000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w, 45001))).toEqual(denied("OVER_DAY_CAP"));
    });

    it("ignores failed and rejected payouts today", async () => {
      const w2 = await makeWorld();
      const w3 = await makeWorld();
      await addPayout(w2, { amount: 900000, status: "failed" });
      await addPayout(w3, { amount: 900000, status: "rejected" });
      await setGuardrails({ maxPerDay: 45000 });
      expect(await check(depositRequest(w, 45000))).toEqual({ verdict: "allow" });
    });

    it("counts in-flight payouts from other cats", async () => {
      const w2 = await makeWorld();
      await addPayout(w2, { amount: 20000, status: "awaiting_approval" });
      await setGuardrails({ maxPerDay: 60000 });
      expect(await check(depositRequest(w, 40000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w, 40001))).toEqual(denied("OVER_DAY_CAP"));
    });
  });

  describe("OVER_ALLOCATION", () => {
    it("counts paid plus in-flight plus this amount, inclusive at the allocation", async () => {
      const w2 = await makeWorld({ funded: 100000 });
      const other = await makeBooking(w2.cat.id, w2.vet.id, "completed");
      await addPayout({ ...w2, booking: other }, { amount: 30000, status: "succeeded" });
      const third = await makeBooking(w2.cat.id, w2.vet.id, "completed");
      await addPayout({ ...w2, booking: third }, { amount: 20000, status: "queued" });
      expect(await check(depositRequest(w2, 50000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w2, 50001))).toEqual(denied("OVER_ALLOCATION"));
    });

    it("subtracts surplus returned to the pool", async () => {
      const [{ id: donationId }] = await db.select().from(donations).limit(1);
      await db
        .insert(allocations)
        .values({ donationId, catId: w.cat.id, purpose: "vet", amount: -210000 });
      expect(await check(depositRequest(w, 40000))).toEqual({ verdict: "allow" });
      expect(await check(depositRequest(w, 40001))).toEqual(denied("OVER_ALLOCATION"));
    });

    it("ignores allocations from donations that were not captured", async () => {
      const w2 = await makeWorld({ funded: 10000 });
      await fundCat(w2.cat.id, 90000, "refunded");
      expect(await check(depositRequest(w2, 10001))).toEqual(denied("OVER_ALLOCATION"));
    });

    it("denies when the pool as a whole cannot cover the amount", async () => {
      // Cat B spent money from a donation later refunded, so the money held for
      // all cats is now less than cat A's allocation suggests.
      const b = await makeWorld({ funded: 100000 });
      await addPayout(b, { amount: 100000, status: "succeeded" });
      const [alloc] = await db.select().from(allocations).where(eq(allocations.catId, b.cat.id));
      await db
        .update(donations)
        .set({ status: "refunded" })
        .where(eq(donations.id, alloc.donationId));
      expect(await check(depositRequest(w, 150001))).toEqual(denied("OVER_ALLOCATION"));
      expect(await check(depositRequest(w, 150000))).toEqual({ verdict: "allow" });
    });
  });

  describe("re-check of an awaiting payout", () => {
    it("ignores the threshold and excludes this payout from sums and the duplicate check", async () => {
      const p = await addPayout(w, { amount: 250000, status: "awaiting_approval" });
      await setGuardrails({ maxPerDay: 250000 });
      expect(await check(depositRequest(w, 250000))).toEqual(denied("DUPLICATE_PAYOUT"));
      expect(await check(depositRequest(w, 250000), { approvingPayoutId: p.id })).toEqual({
        verdict: "allow",
      });
    });

    it("still counts other payouts", async () => {
      const p = await addPayout(w, { amount: 200000, status: "awaiting_approval" });
      const other = await makeBooking(w.cat.id, w.vet.id, "completed");
      await addPayout({ ...w, booking: other }, { amount: 50001, status: "queued" });
      expect(await check(depositRequest(w, 200000), { approvingPayoutId: p.id })).toEqual(
        denied("OVER_CAT_CAP"),
      );
    });
  });
});
