import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { closePool, db, withColonyLock } from "../src/server/db/client";
import { agentActions, bookings, payouts, users, wakeups } from "../src/server/db/schema";
import { getPoolStatus } from "../src/server/ledger";
import {
  applyPayoutStatus,
  approvePayout,
  reconcilePayouts,
  rejectPayout,
  requestPayout,
  retryUnknownPayouts,
} from "../src/server/moneyGate";
import { closeTestPool, createTestPool, truncateAll } from "./helpers/db";
import {
  FakeGateway,
  addPayout,
  addReceipt,
  ageQueuedPayouts,
  depositRequest,
  makeBooking,
  makeCaretaker,
  makeVet,
  makeWorld,
  setGuardrails,
  type World,
} from "./helpers/payoutFixtures";

// Lets a test skip the guardrail check to reach the unique index, and records
// which Postgres backend each gate transaction ran on.
const hooks = vi.hoisted(() => ({ forceAllow: false, pids: [] as number[] }));

vi.mock("../src/server/guardrails", async (original) => {
  const actual = await original<typeof import("../src/server/guardrails")>();
  const checkSpend: typeof actual.checkSpend = async (tx, r, opts) => {
    const { rows } = await tx.execute(sql`select pg_backend_pid() as pid`);
    hooks.pids.push((rows[0] as { pid: number }).pid);
    if (hooks.forceAllow) return { verdict: "allow" };
    return actual.checkSpend(tx, r, opts);
  };
  return { ...actual, checkSpend };
});

const ask = (w: World, amount = 45000) => ({
  ...depositRequest(w, amount),
  reason: "kapon deposit",
  inputs: { source: "test" },
});

const SENT = (batchId: string) => ({ kind: "sent" as const, batchId, status: "PENDING" });
const UNKNOWN = { kind: "unknown" as const, error: "timeout" };
const REJECTED = { kind: "rejected" as const, error: "HTTP 422 VALIDATION_ERROR" };

async function payoutRow(id: string) {
  const [row] = await db.select().from(payouts).where(eq(payouts.id, id));
  return row;
}
async function actionRow(id: string) {
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, id));
  return row;
}
const reserved = () => withColonyLock(async (tx) => (await getPoolStatus(tx)).reservedPayouts);
const allWakeups = () => db.select().from(wakeups);

describe("money gate", () => {
  let w: World;
  let caretakerId: string;

  beforeEach(async () => {
    await truncateAll();
    hooks.forceAllow = false;
    hooks.pids.length = 0;
    w = await makeWorld();
    caretakerId = (await makeCaretaker()).id;
  });
  afterAll(async () => {
    await closePool();
  });

  describe("denied requests", () => {
    const scenarios: [string, (gw: FakeGateway) => Promise<Parameters<typeof requestPayout>[0]>][] = [
      [
        "PAYEE_NOT_ALLOWED",
        async () => ({ ...ask(w), payeeId: (await makeVet()).id }),
      ],
      ["OVER_CAT_CAP", async () => ask(w, 250001)],
      [
        "OVER_DAY_CAP",
        async () => {
          await setGuardrails({ maxPerDay: 44999 });
          return ask(w);
        },
      ],
      [
        "OVER_ALLOCATION",
        async () => {
          const poor = await makeWorld({ funded: 44999 });
          return ask(poor);
        },
      ],
      [
        "RECEIPT_NOT_VERIFIED",
        async () => {
          await addPayout(w, { amount: 45000, status: "succeeded" });
          const receipt = await addReceipt(w.booking.id, "pending");
          return { ...ask(w, 105000), kind: "balance" as const, receiptId: receipt.id };
        },
      ],
      [
        "DEPOSIT_NOT_PAID",
        async () => {
          const receipt = await addReceipt(w.booking.id);
          return { ...ask(w, 105000), kind: "balance" as const, receiptId: receipt.id };
        },
      ],
      [
        "DUPLICATE_PAYOUT",
        async () => {
          await addPayout(w, { amount: 45000, status: "sent" });
          return ask(w);
        },
      ],
      [
        "BOOKING_NOT_CONFIRMED",
        async () => ({
          ...ask(w),
          bookingId: (await makeBooking(w.cat.id, w.vet.id, "pending")).id,
        }),
      ],
    ];

    it.each(scenarios)(
      "%s: no gateway call, no new payout, and a denied action row",
      async (code, build) => {
        const gw = new FakeGateway();
        const request = await build(gw);
        const before = (await db.select().from(payouts)).length;
        const res = await requestPayout(request, gw);

        expect(res).toMatchObject({ status: "rejected", code });
        expect(res.payoutId).toBeUndefined();
        expect(gw.calls).toEqual([]);
        expect(await db.select().from(payouts)).toHaveLength(before);

        const action = await actionRow(res.actionId);
        expect(action.status).toBe("denied");
        expect(action.inputs).toMatchObject({ source: "test", code });
        expect(action.reason).toBe("kapon deposit");
        expect(action.amount).toBe(request.amount);
      },
    );
  });

  describe("sending", () => {
    it("sends with the payout id as sender batch id and the payee's email, then records the batch", async () => {
      const gw = new FakeGateway([SENT("B-1")]);
      const res = await requestPayout(ask(w), gw);

      expect(res.status).toBe("sent");
      expect(gw.calls).toEqual([
        {
          senderBatchId: res.payoutId,
          receiver: w.vet.paypalEmail,
          amount: 45000,
          note: expect.any(String),
        },
      ]);
      const payout = await payoutRow(res.payoutId!);
      expect(payout).toMatchObject({ status: "sent", paypalPayoutBatchId: "B-1", attempts: 1 });
      const action = await actionRow(res.actionId);
      expect(action).toMatchObject({ status: "sent", paypalRef: "B-1", amount: 45000 });
    });

    it("action row exists before gateway call", async () => {
      const separate: Pool = createTestPool();
      try {
        const gw = new FakeGateway();
        let seen = 0;
        gw.onCreate = async (i) => {
          // A separate connection sees only committed data.
          const { rows } = await separate.query(
            `select p.status, p.attempts, p.amount, a.status as action_status, a.reason
             from payouts p join agent_actions a on a.id = p.action_id
             where p.id = $1`,
            [i.senderBatchId],
          );
          expect(rows).toEqual([
            {
              status: "queued",
              attempts: 1,
              amount: 45000,
              action_status: "queued",
              reason: "kapon deposit",
            },
          ]);
          seen += 1;
        };
        const res = await requestPayout(ask(w), gw);
        expect(res.status).toBe("sent");
        expect(seen).toBe(1);
      } finally {
        await closeTestPool(separate);
      }
    });

    it("sends a balance with a verified receipt and stores the receipt id", async () => {
      await addPayout(w, { amount: 45000, status: "succeeded" });
      const receipt = await addReceipt(w.booking.id);
      const gw = new FakeGateway();
      const res = await requestPayout(
        { ...ask(w, 105000), kind: "balance", receiptId: receipt.id },
        gw,
      );
      expect(res.status).toBe("sent");
      expect((await payoutRow(res.payoutId!)).receiptId).toBe(receipt.id);
    });

    it("first-attempt rejection fails the payout and frees the reservation", async () => {
      const gw = new FakeGateway([REJECTED]);
      const res = await requestPayout(ask(w), gw);
      expect(res.status).toBe("failed");
      expect((await actionRow(res.actionId)).status).toBe("failed");
      expect(await reserved()).toBe(0);
      expect(gw.calls).toHaveLength(1);
    });
  });

  describe("approval", () => {
    it("over threshold waits, then approval sends once and records approved_by", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      expect(res.status).toBe("awaiting_approval");
      expect(gw.calls).toEqual([]);
      expect(await reserved()).toBe(200001);

      const approved = await approvePayout(res.payoutId!, caretakerId, gw);
      expect(approved).toMatchObject({ status: "sent", payoutId: res.payoutId });
      expect(gw.calls).toHaveLength(1);
      expect(gw.calls[0].senderBatchId).toBe(res.payoutId);
      expect((await actionRow(res.actionId)).approvedBy).toBe(caretakerId);
    });

    it("double approve pays once, concurrently and on replay", async () => {
      const gw = new FakeGateway();
      gw.onCreate = () => new Promise((r) => setTimeout(r, 100));
      const res = await requestPayout(ask(w, 200001), gw);

      hooks.pids.length = 0;
      const results = await Promise.all([
        approvePayout(res.payoutId!, caretakerId, gw),
        approvePayout(res.payoutId!, caretakerId, gw),
      ]);
      expect(gw.calls).toHaveLength(1);
      expect(results.map((r) => r.status)).toContain("sent");
      // Only one approval re-ran the guardrails, the other saw it was no longer waiting.
      expect(hooks.pids).toHaveLength(1);

      const replay = await approvePayout(res.payoutId!, caretakerId, gw);
      expect(replay.status).toBe("sent");
      expect(gw.calls).toHaveLength(1);
    });

    it("a cap lowered while awaiting approval blocks the send", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await setGuardrails({ maxPerCat: 200000 });

      const approved = await approvePayout(res.payoutId!, caretakerId, gw);
      expect(approved).toMatchObject({ status: "rejected", code: "OVER_CAT_CAP" });
      expect(gw.calls).toEqual([]);
      expect((await payoutRow(res.payoutId!)).status).toBe("rejected");
      const action = await actionRow(res.actionId);
      expect(action).toMatchObject({ status: "rejected", approvedBy: caretakerId });
      expect(action.inputs).toMatchObject({ source: "test", code: "OVER_CAT_CAP" });
      expect(await reserved()).toBe(0);
    });

    it("a booking cancelled while awaiting approval blocks the send", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, w.booking.id));
      const approved = await approvePayout(res.payoutId!, caretakerId, gw);
      expect(approved).toMatchObject({ status: "rejected", code: "BOOKING_NOT_CONFIRMED" });
      expect(gw.calls).toEqual([]);
    });

    it("rejecting frees the reservation and a later approve is a no-op", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      const rejected = await rejectPayout(res.payoutId!, caretakerId, "too much");
      expect(rejected).toMatchObject({ status: "rejected", payoutId: res.payoutId });
      expect(await reserved()).toBe(0);
      expect((await actionRow(res.actionId)).status).toBe("rejected");

      const approved = await approvePayout(res.payoutId!, caretakerId, gw);
      expect(approved.status).toBe("rejected");
      expect(gw.calls).toEqual([]);

      const again = await requestPayout(ask(w, 200001), gw);
      expect(again.status).toBe("awaiting_approval");
    });

    it("rejecting cannot free money that has left or may have left", async () => {
      for (const status of ["queued", "sent", "needs_review", "succeeded"]) {
        const world = await makeWorld();
        const p = await addPayout(world, { amount: 100, status });
        const res = await rejectPayout(p.id, caretakerId, "no");
        expect(res.status).toBe(status);
        expect((await payoutRow(p.id)).status).toBe(status);
      }
    });

    it("only a caretaker can approve or reject", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await expect(approvePayout(res.payoutId!, w.vet.id, gw)).rejects.toThrow(/caretaker/i);
      await expect(rejectPayout(res.payoutId!, w.vet.id, "no")).rejects.toThrow(/caretaker/i);
      expect(gw.calls).toEqual([]);
      expect((await payoutRow(res.payoutId!)).status).toBe("awaiting_approval");
    });

    it("refuses an unknown payout", async () => {
      const gw = new FakeGateway();
      const missing = "00000000-0000-4000-8000-000000000000";
      await expect(approvePayout(missing, caretakerId, gw)).rejects.toThrow(/not found/i);
      await expect(rejectPayout(missing, caretakerId, "x")).rejects.toThrow(/not found/i);
    });
  });

  describe("concurrency", () => {
    it("concurrent duplicates pay once", async () => {
      const gw = new FakeGateway();
      gw.onCreate = () => new Promise((r) => setTimeout(r, 50));
      const results = await Promise.all([
        requestPayout(ask(w), gw),
        requestPayout(ask(w), gw),
      ]);

      expect(new Set(hooks.pids).size).toBe(2);
      expect(gw.calls).toHaveLength(1);
      expect(results.map((r) => r.status).sort()).toEqual(["rejected", "sent"]);
      expect(results.find((r) => r.status === "rejected")?.code).toBe("DUPLICATE_PAYOUT");
      expect(await db.select().from(payouts)).toHaveLength(1);
    });

    it("the unique index alone stops a duplicate that passed the check", async () => {
      hooks.forceAllow = true;
      const gw = new FakeGateway();
      const results = await Promise.all([
        requestPayout(ask(w), gw),
        requestPayout(ask(w), gw),
      ]);

      expect(gw.calls).toHaveLength(1);
      const denied = results.find((r) => r.status === "rejected")!;
      expect(denied.code).toBe("DUPLICATE_PAYOUT");
      expect(await db.select().from(payouts)).toHaveLength(1);

      // The aborted transaction left no orphan action; the denial has its own row.
      const actions = await db.select().from(agentActions);
      expect(actions).toHaveLength(2);
      const action = await actionRow(denied.actionId);
      expect(action.status).toBe("denied");
      expect(action.inputs).toMatchObject({ source: "test", code: "DUPLICATE_PAYOUT" });
    });

    it("a sweep racing an approval sends once", async () => {
      const gw = new FakeGateway();
      gw.onCreate = () => new Promise((r) => setTimeout(r, 100));
      const res = await requestPayout(ask(w, 200001), gw);
      await db
        .update(payouts)
        .set({ createdAt: sql`now() - interval '1 hour'` })
        .where(eq(payouts.id, res.payoutId!));

      const approve = approvePayout(res.payoutId!, caretakerId, gw);
      const sweeps = Promise.all([
        retryUnknownPayouts(gw),
        retryUnknownPayouts(gw),
        new Promise((r) => setTimeout(r, 20)).then(() => retryUnknownPayouts(gw)),
      ]);
      await Promise.all([approve, sweeps]);
      expect(gw.calls).toHaveLength(1);
      expect((await payoutRow(res.payoutId!)).status).toBe("sent");
    });

    it("concurrent sweeps send a stuck payout once", async () => {
      const first = new FakeGateway([UNKNOWN]);
      const res = await requestPayout(ask(w), first);
      await ageQueuedPayouts();

      const gw = new FakeGateway();
      gw.onCreate = () => new Promise((r) => setTimeout(r, 50));
      await Promise.all([retryUnknownPayouts(gw), retryUnknownPayouts(gw)]);
      expect(gw.calls).toHaveLength(1);
      expect((await payoutRow(res.payoutId!)).attempts).toBe(2);
    });
  });

  describe("lost responses", () => {
    it("lost response keeps money reserved; retry reuses the id; a rejection becomes needs_review", async () => {
      const gw = new FakeGateway([UNKNOWN, UNKNOWN, REJECTED]);
      const res = await requestPayout(ask(w), gw);
      expect(res.status).toBe("queued");
      expect(await reserved()).toBe(45000);

      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      expect((await payoutRow(res.payoutId!)).status).toBe("queued");

      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      const payout = await payoutRow(res.payoutId!);
      expect(payout).toMatchObject({ status: "needs_review", attempts: 3 });
      expect((await actionRow(res.actionId)).status).toBe("needs_review");
      expect(await reserved()).toBe(45000);

      expect(gw.calls.map((c) => c.senderBatchId)).toEqual([
        res.payoutId,
        res.payoutId,
        res.payoutId,
      ]);
      // Needs a human from here on: no more sends.
      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      expect(gw.calls).toHaveLength(3);
      // The reservation also blocks a replacement payout.
      const again = await requestPayout(ask(w), gw);
      expect(again.code).toBe("DUPLICATE_PAYOUT");
    });

    it("a retry that lands records the batch", async () => {
      const gw = new FakeGateway([UNKNOWN, SENT("B-2")]);
      const res = await requestPayout(ask(w), gw);
      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "sent",
        paypalPayoutBatchId: "B-2",
      });
      expect((await actionRow(res.actionId)).paypalRef).toBe("B-2");
    });

    it("moves to needs_review after 5 retries still unknown, and never sends a sixth", async () => {
      const gw = new FakeGateway(Array.from({ length: 10 }, () => UNKNOWN));
      const res = await requestPayout(ask(w), gw);
      for (let retry = 1; retry <= 4; retry++) {
        await ageQueuedPayouts();
        await retryUnknownPayouts(gw);
        expect((await payoutRow(res.payoutId!)).status).toBe("queued");
      }
      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "needs_review",
        attempts: 6,
      });

      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      expect(gw.calls).toHaveLength(6);
      expect(new Set(gw.calls.map((c) => c.senderBatchId))).toEqual(new Set([res.payoutId]));
    });

    it("a gateway that throws is treated as unknown, and money stays reserved", async () => {
      const gw = new FakeGateway([new Error("socket hang up")]);
      const res = await requestPayout(ask(w), gw);
      expect(res.status).toBe("queued");
      expect(await reserved()).toBe(45000);
    });

    it("does not retry a payout attempted within the last 30 seconds", async () => {
      const gw = new FakeGateway([UNKNOWN]);
      await requestPayout(ask(w), gw);
      await retryUnknownPayouts(gw);
      expect(gw.calls).toHaveLength(1);
    });

    it("does not pick up a recently approved send still in flight", async () => {
      const gw = new FakeGateway();
      let sweep: Promise<void> | undefined;
      gw.onCreate = async () => {
        sweep = retryUnknownPayouts(gw);
        await sweep;
      };
      const res = await requestPayout(ask(w, 200001), gw);
      await db
        .update(payouts)
        .set({ createdAt: sql`now() - interval '1 hour'` })
        .where(eq(payouts.id, res.payoutId!));
      await approvePayout(res.payoutId!, caretakerId, gw);
      expect(sweep).toBeDefined();
      expect(gw.calls).toHaveLength(1);
    });

    it("crash before the first call: attempts 0 counts as a first attempt, so a rejection fails", async () => {
      const p = await addPayout(w, {
        amount: 45000,
        status: "queued",
        attempts: 0,
        createdAt: new Date(Date.now() - 3_600_000),
      });
      const gw = new FakeGateway([REJECTED]);
      await retryUnknownPayouts(gw);
      expect(gw.calls[0].senderBatchId).toBe(p.id);
      expect(await payoutRow(p.id)).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("crash after the attempt was recorded: a rejection is ambiguous, so needs_review", async () => {
      const p = await addPayout(w, {
        amount: 45000,
        status: "queued",
        attempts: 1,
        createdAt: new Date(Date.now() - 3_600_000),
      });
      const gw = new FakeGateway([REJECTED]);
      await retryUnknownPayouts(gw);
      expect(await payoutRow(p.id)).toMatchObject({ status: "needs_review", attempts: 2 });
    });

    it("a sender that died on its last attempt leaves no more retries", async () => {
      const p = await addPayout(w, {
        amount: 45000,
        status: "queued",
        attempts: 6,
        createdAt: new Date(Date.now() - 3_600_000),
      });
      const gw = new FakeGateway();
      await retryUnknownPayouts(gw);
      expect(gw.calls).toEqual([]);
      expect((await payoutRow(p.id)).status).toBe("needs_review");
    });

    it("retries approved payouts whose sender died before calling", async () => {
      const p = await addPayout(w, {
        amount: 45000,
        status: "queued",
        createdAt: new Date(Date.now() - 3_600_000),
      });
      const gw = new FakeGateway([SENT("B-3")]);
      await retryUnknownPayouts(gw);
      expect((await payoutRow(p.id)).status).toBe("sent");
    });

    it("a payee who lost their email goes to needs_review with no call", async () => {
      const first = new FakeGateway([UNKNOWN]);
      const res = await requestPayout(ask(w), first);
      await db.update(users).set({ paypalEmail: null }).where(eq(users.id, w.vet.id));
      await ageQueuedPayouts();
      const gw = new FakeGateway();
      await retryUnknownPayouts(gw);
      expect(gw.calls).toEqual([]);
      expect((await payoutRow(res.payoutId!)).status).toBe("needs_review");
      expect(await reserved()).toBe(45000);
    });
  });

  describe("applyPayoutStatus", () => {
    async function sentPayout(batchId = "B-9") {
      return addPayout(w, { amount: 45000, status: "sent", batchId });
    }

    it("SUCCESS records fee and item id and enqueues one wakeup", async () => {
      const p = await sentPayout();
      await applyPayoutStatus("B-9", { itemStatus: "SUCCESS", itemId: "I-1", fee: 2500 });
      expect(await payoutRow(p.id)).toMatchObject({
        status: "succeeded",
        fee: 2500,
        paypalItemId: "I-1",
      });
      expect((await actionRow(p.actionId)).status).toBe("succeeded");
      const queued = await allWakeups();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: "payout_status_changed", status: "pending" });
      expect(queued[0].payload).toMatchObject({ payoutId: p.id, status: "succeeded" });
      expect(JSON.stringify(queued[0].payload)).not.toContain("@");
    });

    it("failed payout frees reservation", async () => {
      const gw = new FakeGateway([SENT("B-5")]);
      const res = await requestPayout(ask(w), gw);
      expect(await reserved()).toBe(45000);
      await applyPayoutStatus("B-5", { itemStatus: "FAILED", itemId: "I-5" });
      expect((await payoutRow(res.payoutId!)).status).toBe("failed");
      expect(await reserved()).toBe(0);
      const again = await requestPayout(ask(w), gw);
      expect(again.status).toBe("sent");
      expect(again.payoutId).not.toBe(res.payoutId);
    });

    it.each(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "CANCELED"])(
      "%s fails a sent payout",
      async (itemStatus) => {
        const p = await sentPayout();
        await applyPayoutStatus("B-9", { itemStatus });
        expect((await payoutRow(p.id)).status).toBe("failed");
        expect(await allWakeups()).toHaveLength(1);
      },
    );

    it.each(["UNCLAIMED", "HELD", "PENDING", "ONHOLD", "SOMETHING_NEW"])(
      "%s leaves it sent, no wakeup",
      async (itemStatus) => {
        const p = await sentPayout();
        await applyPayoutStatus("B-9", { itemStatus });
        expect((await payoutRow(p.id)).status).toBe("sent");
        expect(await allWakeups()).toEqual([]);
      },
    );

    it("replayed status is a no-op", async () => {
      const p = await sentPayout();
      const update = { itemStatus: "SUCCESS", itemId: "I-1", fee: 2500 };
      await applyPayoutStatus("B-9", update);
      await applyPayoutStatus("B-9", update);
      await applyPayoutStatus("B-9", { ...update, fee: 9999, itemId: "I-2" });
      expect(await payoutRow(p.id)).toMatchObject({
        status: "succeeded",
        fee: 2500,
        paypalItemId: "I-1",
      });
      expect(await allWakeups()).toHaveLength(1);
    });

    it("concurrent replays enqueue one wakeup", async () => {
      await sentPayout();
      const update = { itemStatus: "SUCCESS", itemId: "I-1", fee: 2500 };
      await Promise.all([
        applyPayoutStatus("B-9", update),
        applyPayoutStatus("B-9", update),
        applyPayoutStatus("B-9", update),
      ]);
      expect(await allWakeups()).toHaveLength(1);
    });

    it.each(["RETURNED", "REFUNDED"])("succeeded regresses to failed for %s", async (itemStatus) => {
      const p = await sentPayout();
      await applyPayoutStatus("B-9", { itemStatus: "SUCCESS", fee: 2500 });
      await applyPayoutStatus("B-9", { itemStatus });
      expect((await payoutRow(p.id)).status).toBe("failed");
      expect(await allWakeups()).toHaveLength(2);
    });

    it.each(["FAILED", "BLOCKED", "REVERSED", "CANCELED", "PENDING", "UNCLAIMED"])(
      "succeeded does not regress for %s",
      async (itemStatus) => {
        const p = await sentPayout();
        await applyPayoutStatus("B-9", { itemStatus: "SUCCESS" });
        await applyPayoutStatus("B-9", { itemStatus });
        expect((await payoutRow(p.id)).status).toBe("succeeded");
        expect(await allWakeups()).toHaveLength(1);
      },
    );

    it("a failed payout never comes back", async () => {
      const p = await sentPayout();
      await applyPayoutStatus("B-9", { itemStatus: "FAILED" });
      await applyPayoutStatus("B-9", { itemStatus: "SUCCESS" });
      await applyPayoutStatus("B-9", { itemStatus: "PENDING" });
      expect((await payoutRow(p.id)).status).toBe("failed");
      expect(await allWakeups()).toHaveLength(1);
    });

    it("cannot move a needs_review or rejected payout", async () => {
      const w2 = await makeWorld();
      const review = await addPayout(w, { amount: 1, status: "needs_review", batchId: "R-1" });
      const rejected = await addPayout(w2, { amount: 1, status: "rejected", batchId: "R-2" });
      await applyPayoutStatus("R-1", { itemStatus: "FAILED" });
      await applyPayoutStatus("R-2", { itemStatus: "SUCCESS" });
      expect((await payoutRow(review.id)).status).toBe("needs_review");
      expect((await payoutRow(rejected.id)).status).toBe("rejected");
      expect(await allWakeups()).toEqual([]);
    });

    it("ignores an unknown batch id", async () => {
      await expect(applyPayoutStatus("nope", { itemStatus: "SUCCESS" })).resolves.toBeUndefined();
      expect(await allWakeups()).toEqual([]);
    });

    it("rolls back the status when the wakeup cannot be written", async () => {
      const p = await sentPayout();
      await db.execute(sql`alter table wakeups add constraint no_writes check (kind <> 'payout_status_changed') not valid`);
      try {
        await expect(applyPayoutStatus("B-9", { itemStatus: "SUCCESS" })).rejects.toThrow();
        expect((await payoutRow(p.id)).status).toBe("sent");
      } finally {
        await db.execute(sql`alter table wakeups drop constraint no_writes`);
      }
    });
  });

  describe("reconcilePayouts", () => {
    it("polls only sent payouts and applies item statuses", async () => {
      const w2 = await makeWorld();
      const w3 = await makeWorld();
      const a = await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      const b = await addPayout(w2, { amount: 1, status: "sent", batchId: "B" });
      await addPayout(w3, { amount: 1, status: "succeeded", batchId: "C" });
      const gw = new FakeGateway();
      const get = vi.spyOn(gw, "get");
      gw.statuses.set("A", {
        batchStatus: "SUCCESS",
        itemId: "I-A",
        itemStatus: "SUCCESS",
        fee: 1500,
      });
      gw.statuses.set("B", { batchStatus: "PROCESSING", itemStatus: "PENDING" });
      await reconcilePayouts(gw);
      expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(["A", "B"]);
      expect(await payoutRow(a.id)).toMatchObject({
        status: "succeeded",
        fee: 1500,
        paypalItemId: "I-A",
      });
      expect((await payoutRow(b.id)).status).toBe("sent");
    });

    it.each(["DENIED", "CANCELED"])("batch-level %s fails the payout", async (batchStatus) => {
      const p = await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      const gw = new FakeGateway();
      gw.statuses.set("A", { batchStatus });
      await reconcilePayouts(gw);
      expect((await payoutRow(p.id)).status).toBe("failed");
      expect(await allWakeups()).toHaveLength(1);
    });

    it("a dead batch fails even when its item still says pending", async () => {
      const p = await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      const gw = new FakeGateway();
      gw.statuses.set("A", { batchStatus: "DENIED", itemStatus: "PENDING" });
      await reconcilePayouts(gw);
      expect((await payoutRow(p.id)).status).toBe("failed");
    });

    it("an item that succeeded is believed over a dead batch, so paid money stays counted", async () => {
      const p = await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      const gw = new FakeGateway();
      gw.statuses.set("A", { batchStatus: "CANCELED", itemStatus: "SUCCESS" });
      await reconcilePayouts(gw);
      expect((await payoutRow(p.id)).status).toBe("succeeded");
    });

    it("one failed poll does not stop the others", async () => {
      const w2 = await makeWorld();
      const a = await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      const b = await addPayout(w2, { amount: 1, status: "sent", batchId: "B" });
      const gw = new FakeGateway();
      gw.statuses.set("A", new Error("network"));
      gw.statuses.set("B", new Error("network"));
      await reconcilePayouts(gw);
      expect((await payoutRow(a.id)).status).toBe("sent");
      gw.statuses.set("B", { batchStatus: "SUCCESS", itemStatus: "SUCCESS" });
      await reconcilePayouts(gw);
      expect((await payoutRow(a.id)).status).toBe("sent");
      expect((await payoutRow(b.id)).status).toBe("succeeded");
    });
  });
});
