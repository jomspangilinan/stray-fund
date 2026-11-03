import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { agentActions, payouts, wakeups } from "../src/server/db/schema";
import { runAction } from "../src/server/caretaker";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { applyPayoutStatus, requestPayout } from "../src/server/moneyGate";
import { BATCH_EXISTS_FLAG } from "../src/server/payoutRetry";
import { truncateAll } from "./helpers/db";
import { FakeGateway, addPayout, depositRequest, makeCaretaker, makeWorld, type World } from "./helpers/payoutFixtures";

let w: World;
const ask = () => requestPayout({ ...depositRequest(w), reason: "Try.", inputs: {} }, new FakeGateway());
const allow = async (payoutId: string, note?: string) => {
  const care = await makeCaretaker();
  return runAction("payout_allow_retry", care.id, { payoutId, ...(note === undefined ? {} : { note }) });
};
const find = async (id: string) => (await getCaretakerQueue()).needsReview.find((p) => p.id === id);

beforeEach(async () => {
  await truncateAll();
  w = await makeWorld();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(closePool);

describe("Allow a new try", () => {
  it("a rejected row blocks the agent until a caretaker allows one more try with a note, and then it is payable once", async () => {
    const rejected = await addPayout(w, { amount: 45000, status: "rejected" });
    expect(await ask()).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
    expect(await find(rejected.id)).toMatchObject({ canAllowRetry: true });

    expect(await allow(rejected.id)).toMatchObject({ ok: false, status: 400 });
    const before = (await db.select().from(wakeups)).length;
    expect(await allow(rejected.id, "I rejected the wrong one.")).toMatchObject({ ok: true });
    const [row] = await db.select().from(payouts).where(eq(payouts.id, rejected.id));
    expect(row.retryClearedBy).not.toBeNull();
    expect((await db.select().from(wakeups)).length).toBe(before + 1);
    const audit = await db.select().from(agentActions).where(eq(agentActions.action, "payout_retry_allowed"));
    expect(audit).toHaveLength(1);
    expect(audit[0].inputs).toMatchObject({ payoutId: rejected.id, note: "I rejected the wrong one." });
    expect(await find(rejected.id)).toBeUndefined();

    // Payable once.
    const first = await ask();
    expect(first.code).toBeUndefined();
    expect(first.payoutId).toBeDefined();
    await db.update(payouts).set({ status: "rejected" }).where(eq(payouts.id, first.payoutId!));
    expect(await ask()).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
  });

  it("twice-failed rows: clearing one gives exactly one more try", async () => {
    const a = await addPayout(w, { amount: 45000, status: "failed" });
    await addPayout(w, { amount: 45000, status: "failed" });
    expect(await ask()).toMatchObject({ code: "REVIEW_REQUIRED" });
    expect(await allow(a.id, "Both failures were our network.")).toMatchObject({ ok: true });
    const next = await ask();
    expect(next.code).toBeUndefined();
    await db.update(payouts).set({ status: "failed" }).where(eq(payouts.id, next.payoutId!));
    expect(await ask()).toMatchObject({ code: "REVIEW_REQUIRED" });
  });

  it.each([
    ["has a batch id at PayPal", async (id: string) => { await db.update(payouts).set({ paypalPayoutBatchId: "B-1" }).where(eq(payouts.id, id)); }],
    ["has the BATCH_EXISTS flag", async (id: string) => { await db.update(payouts).set({ lastGatewayError: `${BATCH_EXISTS_FLAG}: HTTP 400` }).where(eq(payouts.id, id)); }],
    ["has a late-success pointer", async (id: string) => {
      await db.update(payouts).set({ status: "failed", paypalPayoutBatchId: "B-2" }).where(eq(payouts.id, id));
      await applyPayoutStatus("B-2", { itemStatus: "SUCCESS" });
    }],
  ])("is refused on a row that %s", async (_name, mark) => {
    const p = await addPayout(w, { amount: 45000, status: "rejected" });
    await mark(p.id);
    expect(await allow(p.id, "Please.")).toMatchObject({ ok: false, status: 409 });
    expect((await db.select().from(payouts).where(eq(payouts.id, p.id)))[0].retryClearedBy).toBeNull();
    expect((await ask()).code).toMatch(/REVIEW_REQUIRED/);
    expect(await find(p.id).then((i) => i?.canAllowRetry ?? false)).toBe(false);
  });

  it("is refused on a live row and a second click changes nothing", async () => {
    const live = await addPayout(w, { amount: 45000, status: "sent", batchId: "B-9" });
    expect(await allow(live.id, "x")).toMatchObject({ ok: false });
    const rejected = await addPayout(w, { amount: 45000, status: "rejected", kind: "balance" });
    expect(await allow(rejected.id, "once")).toMatchObject({ ok: true });
    expect(await allow(rejected.id, "twice")).toMatchObject({ ok: false });
    expect(await db.select().from(agentActions).where(eq(agentActions.action, "payout_retry_allowed"))).toHaveLength(1);
  });
});
