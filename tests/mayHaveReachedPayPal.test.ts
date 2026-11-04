import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { payouts } from "../src/server/db/schema";
import { runAction } from "../src/server/caretaker";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { createAgentTools, payoutRetryBlocked } from "../src/server/agent/tools";
import { applyPayoutStatus, resolveNeedsReview, retryUnknownPayouts } from "../src/server/moneyGate";
import { truncateAll } from "./helpers/db";
import { FakeGateway, addPayout, ageQueuedPayouts, depositRequest, makeCaretaker, makeWorld, requestAndApprove, type World } from "./helpers/payoutFixtures";

let w: World;
const ask = (gw = new FakeGateway()) => requestAndApprove({ ...depositRequest(w), reason: "Try.", inputs: {} }, gw);
const row = async (id: string) => (await db.select().from(payouts).where(eq(payouts.id, id)))[0];
const allow = async (payoutId: string) => runAction("payout_allow_retry", (await makeCaretaker()).id, { payoutId, note: "Checked." });
const queueRow = async (id: string) => {
  const q = await getCaretakerQueue();
  return q.needsReview.find((p) => p.id === id);
};
async function agentPays() {
  const { tools } = createAgentTools({ gateway: new FakeGateway(), now: () => new Date() });
  const tool = tools.find((t) => t.name === "pay_vet_deposit")!;
  try {
    await tool.run(tool.parse({ booking_id: w.booking.id, reason: "Again." }));
    return "paid";
  } catch (e) {
    return JSON.parse(String((e as { content?: unknown }).content)).code as string;
  }
}

beforeEach(async () => {
  await truncateAll();
  w = await makeWorld();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(closePool);

describe("a row that may have reached PayPal is held like one with a batch id", () => {
  describe("attempts above one, no batch id", () => {
    it("a lost first send then a 422 stays in review: not paid is refused, the desk does not offer it, the agent cannot ask again", async () => {
      const gw = new FakeGateway([{ kind: "unknown", error: "timeout" }, { kind: "rejected", error: "HTTP 422 UNPROCESSABLE_ENTITY" }]);
      const res = await ask(gw);
      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      const p = await row(res.payoutId!);
      expect(p).toMatchObject({ status: "needs_review", attempts: 2, paypalPayoutBatchId: null });

      await db.update(payouts).set({ lastAttemptAt: new Date(Date.now() - 10 * 60_000) }).where(eq(payouts.id, p.id));
      const care = await makeCaretaker();
      await expect(resolveNeedsReview(p.id, care.id, { outcome: "not_paid", note: "Looks refused." })).rejects.toThrow(/reached PayPal/);
      expect((await row(p.id)).status).toBe("needs_review");
      expect(await queueRow(p.id)).toMatchObject({ canRuleNotPaid: false });
      expect(await ask()).toMatchObject({ status: "rejected", code: "DUPLICATE_PAYOUT" });
      expect(await agentPays()).not.toBe("paid");
    });

    it("a failed row with two attempts cannot get a new try, blocks the gate and the agent tool", async () => {
      const p = await addPayout(w, { amount: 45000, status: "failed", attempts: 2 });
      expect(await allow(p.id)).toMatchObject({ ok: false });
      expect((await row(p.id)).retryClearedBy).toBeNull();
      expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(true);
      expect(await ask()).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
      expect(await agentPays()).toBe("REVIEW_REQUIRED");
      expect(await queueRow(p.id)).toBeUndefined();
    });
  });

  describe("a definite first-try refusal", () => {
    it("stays eligible: one try allowed with a note, and one failed row alone does not stop the agent", async () => {
      const a = await addPayout(w, { amount: 45000, status: "failed", attempts: 1, lastGatewayError: "HTTP 422 UNPROCESSABLE_ENTITY" });
      expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(false);
      const b = await addPayout(w, { amount: 45000, status: "failed", attempts: 1, lastGatewayError: "HTTP 400 VALIDATION_ERROR" });
      expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(true);
      expect(await queueRow(a.id)).toMatchObject({ canAllowRetry: true });
      expect(await allow(a.id)).toMatchObject({ ok: true });
      expect((await row(a.id)).retryClearedBy).not.toBeNull();
      expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(false);
      expect(b.id).toBeDefined();
    });

    it("a first send with no payee email, ruled not paid, is allowed", async () => {
      const p = await addPayout(w, { amount: 45000, status: "needs_review", attempts: 1, lastGatewayError: "Payee has no PayPal email" });
      expect(await queueRow(p.id)).toMatchObject({ canRuleNotPaid: true });
      await resolveNeedsReview(p.id, (await makeCaretaker()).id, { outcome: "not_paid", note: "No email on file." });
      expect((await row(p.id)).status).toBe("failed");
    });
  });

  describe.each(["PENDING", "UNCLAIMED", "ONHOLD"])("a %s event on a failed row", (itemStatus) => {
    it("keeps its batch id and blocks the agent, new tries and not paid", async () => {
      const p = await addPayout(w, { amount: 45000, status: "failed", attempts: 1 });
      await applyPayoutStatus("B-LATE", { itemStatus, senderBatchId: p.id });
      expect(await row(p.id)).toMatchObject({ status: "failed", paypalPayoutBatchId: "B-LATE", paypalItemStatus: itemStatus });
      expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(true);
      expect(await ask()).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
      expect(await agentPays()).toBe("REVIEW_REQUIRED");
      expect(await allow(p.id)).toMatchObject({ ok: false });
    });

    it("and PayPal's later FAILED says the money did not leave, which frees the booking", async () => {
      const p = await addPayout(w, { amount: 45000, status: "failed", attempts: 1 });
      await applyPayoutStatus("B-LATE", { itemStatus, senderBatchId: p.id });
      await applyPayoutStatus("B-LATE", { itemStatus: "FAILED" });
      expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(false);
    });
  });

  it("an item status already on a failed row with no batch id also blocks", async () => {
    await addPayout(w, { amount: 45000, status: "failed", attempts: 1, itemStatus: "PENDING" });
    expect(await payoutRetryBlocked(w.booking.id, "deposit")).toBe(true);
  });
});
