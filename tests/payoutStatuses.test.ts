import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db, withColonyLock } from "../src/server/db/client";
import { payouts, reviewRequests, wakeups } from "../src/server/db/schema";
import { getPoolStatus } from "../src/server/ledger";
import { applyPayoutStatus, reconcilePayouts, requestPayout, resolveNeedsReview } from "../src/server/moneyGate";
import { handleWebhookEvent } from "../src/server/paypal/webhook";
import { truncateAll } from "./helpers/db";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { FakeGateway, addPayout, depositRequest, makeCaretaker, makeWorld, type World } from "./helpers/payoutFixtures";

/*
 * Every status the Payouts schema lists (https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json):
 * item: SUCCESS FAILED PENDING UNCLAIMED RETURNED ONHOLD BLOCKED REFUNDED REVERSED
 * batch: DENIED PENDING PROCESSING SUCCESS CANCELED
 * Only SUCCESS may ever show as paid.
 */

let w: World;
const row = async (id: string) => (await db.select().from(payouts).where(eq(payouts.id, id)))[0];
const pool = () => withColonyLock((tx) => getPoolStatus(tx));
const asked = () => db.select().from(reviewRequests);

async function sentPayout(batchId = "B-1") {
  return addPayout(w, { amount: 45000, status: "sent", batchId });
}

beforeEach(async () => {
  await truncateAll();
  w = await makeWorld();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(closePool);

describe("polling a batch, every status in the schema", () => {
  const ITEM: [string, string][] = [
    ["SUCCESS", "succeeded"],
    ["FAILED", "failed"],
    ["RETURNED", "failed"],
    ["BLOCKED", "needs_review"],
    ["REFUNDED", "failed"],
    ["REVERSED", "needs_review"],
    ["PENDING", "sent"],
    ["UNCLAIMED", "sent"],
    ["ONHOLD", "sent"],
  ];
  it.each(ITEM)("item %s leaves a sent payout %s, and it counts as paid only when succeeded", async (itemStatus, expected) => {
    const p = await sentPayout();
    const gw = new FakeGateway();
    gw.statuses.set("B-1", { batchStatus: "SUCCESS", itemStatus, itemId: "I-1", fee: 100 });
    await reconcilePayouts(gw);
    expect((await row(p.id)).status).toBe(expected);
    expect((await pool()).vetPaid).toBe(expected === "succeeded" ? 45000 : 0);
    // Anything not proven final holds the reservation, so the agent cannot pay again while it is open.
    expect((await pool()).reservedPayouts).toBe(["sent", "needs_review"].includes(expected) ? 45000 : 0);
  });

  const BATCH: [string, string | undefined, string][] = [
    ["PENDING", undefined, "sent"],
    ["PROCESSING", undefined, "sent"],
    ["SUCCESS", undefined, "sent"],
    ["DENIED", undefined, "failed"],
    ["CANCELED", undefined, "failed"],
    ["DENIED", "PENDING", "failed"],
    ["CANCELED", "SUCCESS", "succeeded"],
  ];
  it.each(BATCH)("batch %s with item %s leaves a sent payout %s", async (batchStatus, itemStatus, expected) => {
    const p = await sentPayout();
    const gw = new FakeGateway();
    gw.statuses.set("B-1", { batchStatus, itemStatus });
    await reconcilePayouts(gw);
    expect((await row(p.id)).status).toBe(expected);
  });

  it.each(["RETURNED", "REFUNDED"])("a payout shown as paid is shown unpaid again when PayPal says %s", async (itemStatus) => {
    const p = await sentPayout();
    const gw = new FakeGateway();
    gw.statuses.set("B-1", { batchStatus: "SUCCESS", itemStatus: "SUCCESS", fee: 100 });
    await reconcilePayouts(gw);
    expect((await pool()).vetPaid).toBe(45000);
    gw.statuses.set("B-1", { batchStatus: "SUCCESS", itemStatus });
    await applyPayoutStatus("B-1", { itemStatus });
    expect((await row(p.id)).status).toBe("failed");
    expect(await pool()).toMatchObject({ vetPaid: 0, payoutFees: 0 });
  });
});

describe("a BLOCKED payout", () => {
  it("goes to review and keeps the reservation, so the booking cannot be paid a second time", async () => {
    const p = await sentPayout();
    await applyPayoutStatus("B-1", { itemStatus: "BLOCKED" });
    const after = await row(p.id);
    expect(after.status).toBe("needs_review");
    expect((await pool()).reservedPayouts).toBe(45000);
    // A second BLOCKED poll changes nothing and makes no second wakeup.
    const wakeupsBefore = (await db.select().from(wakeups)).length;
    await applyPayoutStatus("B-1", { itemStatus: "BLOCKED" });
    expect((await db.select().from(wakeups)).length).toBe(wakeupsBefore);
    // The booking is still held by the live payout.
    expect(await requestPayout({ ...depositRequest(w), reason: "Again.", inputs: {} }, new FakeGateway())).toMatchObject({ status: "rejected", code: "DUPLICATE_PAYOUT" });
  });

  it("clears to succeeded when PayPal later says SUCCESS", async () => {
    const p = await sentPayout();
    await applyPayoutStatus("B-1", { itemStatus: "BLOCKED" });
    await applyPayoutStatus("B-1", { itemStatus: "SUCCESS", fee: 100 });
    expect((await row(p.id)).status).toBe("succeeded");
  });

  describe.each(["BLOCKED", "REVERSED"])("a %s row that has a batch id at PayPal", (itemStatus) => {
    it("cannot be ruled not paid by anyone: it stays in review with its money held", async () => {
      const p = await sentPayout();
      await applyPayoutStatus("B-1", { itemStatus });
      const care = await makeCaretaker();
      await expect(resolveNeedsReview(p.id, care.id, { outcome: "not_paid", note: "Checked at PayPal: blocked." })).rejects.toThrow(/batch/);
      expect((await row(p.id)).status).toBe("needs_review");
      expect((await pool()).reservedPayouts).toBe(45000);
    });

    it("the desk does not offer 'not paid', and says to check PayPal and ask a developer", async () => {
      const p = await sentPayout();
      await applyPayoutStatus("B-1", { itemStatus });
      expect((await getCaretakerQueue()).needsReview.find((i) => i.id === p.id)).toMatchObject({ canRuleNotPaid: false, itemStatus });
    });

    it("the agent cannot make another payout for the booking, by the gate or by its tool", async () => {
      const p = await sentPayout();
      await applyPayoutStatus("B-1", { itemStatus });
      const gw = new FakeGateway();
      expect(await requestPayout({ ...depositRequest(w), reason: "Again.", inputs: {} }, gw)).toMatchObject({ status: "rejected", code: "DUPLICATE_PAYOUT" });
      expect(gw.calls).toHaveLength(0);
      expect(await db.select().from(payouts).where(eq(payouts.bookingId, p.bookingId))).toHaveLength(1);
    });
  });

  it("FAILED after BLOCKED frees it", async () => {
    const p = await sentPayout();
    await applyPayoutStatus("B-1", { itemStatus: "BLOCKED" });
    await applyPayoutStatus("B-1", { itemStatus: "FAILED" });
    expect((await row(p.id)).status).toBe("failed");
    expect((await pool()).reservedPayouts).toBe(0);
  });
});

describe("a success PayPal reports after we called the payout failed", () => {
  it("is not shown as paid, is not hidden, and puts a question on the caretaker desk once", async () => {
    const p = await sentPayout();
    await applyPayoutStatus("B-1", { itemStatus: "FAILED" });
    expect((await row(p.id)).status).toBe("failed");
    expect(await asked()).toHaveLength(0);

    await applyPayoutStatus("B-1", { itemStatus: "SUCCESS", fee: 100 });
    await applyPayoutStatus("B-1", { itemStatus: "SUCCESS", fee: 100 });
    const after = await row(p.id);
    // The money did leave, but nobody has checked, so the books do not call it paid and a person must.
    expect(after.status).toBe("failed");
    expect((await pool()).vetPaid).toBe(0);
    const qs = await asked();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ status: "open" });
    expect(qs[0].reason).toContain(p.id);
    expect(after.lateSuccessReviewId).toBe(qs[0].id);
  });

  it("other late statuses on a failed payout ask nothing", async () => {
    await sentPayout();
    await applyPayoutStatus("B-1", { itemStatus: "FAILED" });
    for (const itemStatus of ["PENDING", "ONHOLD", "UNCLAIMED", "RETURNED"]) {
      await applyPayoutStatus("B-1", { itemStatus });
    }
    expect(await asked()).toHaveLength(0);
  });
});

describe("the webhook when the resource carries no transaction_status", () => {
  const EVENTS: [string, string][] = [
    ["SUCCEEDED", "succeeded"],
    ["FAILED", "failed"],
    ["BLOCKED", "needs_review"],
    ["CANCELED", "failed"],
    ["REFUNDED", "failed"],
    ["RETURNED", "failed"],
    ["HELD", "sent"],
    ["UNCLAIMED", "sent"],
  ];
  it.each(EVENTS)("PAYMENT.PAYOUTS-ITEM.%s settles a sent payout as %s", async (suffix, expected) => {
    const p = await sentPayout();
    await handleWebhookEvent({
      id: `EV-${suffix}`,
      event_type: `PAYMENT.PAYOUTS-ITEM.${suffix}`,
      resource: { payout_batch_id: "B-1", sender_batch_id: p.id },
    });
    expect((await row(p.id)).status).toBe(expected);
  });

  it("the resource's own status wins over the event name", async () => {
    const p = await sentPayout();
    await handleWebhookEvent({
      id: "EV-X",
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_batch_id: "B-1", sender_batch_id: p.id, transaction_status: "ONHOLD" },
    });
    expect((await row(p.id)).status).toBe("sent");
  });
});
