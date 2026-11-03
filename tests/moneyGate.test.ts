import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { closePool, db, withColonyLock } from "../src/server/db/client";
import { agentActions, bookings, payouts, users, wakeups } from "../src/server/db/schema";
import { getPoolStatus } from "../src/server/ledger";
import { BATCH_EXISTS_FLAG } from "../src/server/payoutRetry";
import {
  IN_FLIGHT_WINDOW_SECONDS,
  applyPayoutStatus,
  approvePayout,
  reconcilePayouts,
  rejectPayout,
  requestPayout,
  resolveNeedsReview,
  retryUnknownPayouts,
} from "../src/server/moneyGate";
import { clearPayPalTokenCache, restPayoutGateway } from "../src/server/paypal/payouts";
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

const DUPLICATE_ERROR = "HTTP 400 USER_BUSINESS_ERROR SENDER_BATCH_ID";
const DUPLICATE = (batchId?: string) => ({
  kind: "duplicate" as const,
  error: DUPLICATE_ERROR,
  ...(batchId ? { batchId } : {}),
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
const YESTERDAY = () => new Date(Date.now() - 86_400_000);

async function blockWakeups(fn: () => Promise<void>) {
  await db.execute(sql`alter table wakeups add constraint no_writes check (kind <> 'payout_status_changed') not valid`);
  try {
    await fn();
  } finally {
    await db.execute(sql`alter table wakeups drop constraint no_writes`);
  }
}

async function expectOneWakeup(payoutId: string, status: string, previousStatus: string) {
  const rows = await allWakeups();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "payout_status_changed", status: "pending" });
  expect(rows[0].payload).toMatchObject({ payoutId, status, previousStatus });
}

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
        expect(action.inputs).toMatchObject({
          source: "test",
          code,
          bookingId: request.bookingId,
          catId: request.catId,
          payeeId: request.payeeId,
        });
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
      await expectOneWakeup(res.payoutId!, "failed", "queued");
      expect((await payoutRow(res.payoutId!)).lastGatewayError).toBe(REJECTED.error);
    });

    it("a move to sent enqueues no wakeup", async () => {
      await requestPayout(ask(w), new FakeGateway());
      expect(await allWakeups()).toEqual([]);
    });

    it("an approved payout rejected by the gateway fails with a wakeup", async () => {
      const first = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), first);
      const approved = await approvePayout(res.payoutId!, caretakerId, new FakeGateway([REJECTED]));
      expect(approved.status).toBe("failed");
      await expectOneWakeup(res.payoutId!, "failed", "queued");
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

    it("approving an old payout counts it against today, so the next one is over the cap", async () => {
      const a = await makeWorld();
      const b = await makeWorld();
      const pa = await addPayout(a, { amount: 150000, status: "awaiting_approval", createdAt: YESTERDAY() });
      const pb = await addPayout(b, { amount: 150000, status: "awaiting_approval", createdAt: YESTERDAY() });
      await setGuardrails({ maxPerDay: 200000 });
      const gw = new FakeGateway();

      expect((await approvePayout(pa.id, caretakerId, gw)).status).toBe("sent");
      const second = await approvePayout(pb.id, caretakerId, gw);
      expect(second).toMatchObject({ status: "rejected", code: "OVER_DAY_CAP" });
      expect(gw.calls).toHaveLength(1);
    });

    it("an approve-time denial enqueues a wakeup carrying the code", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await setGuardrails({ maxPerCat: 200000 });
      await approvePayout(res.payoutId!, caretakerId, gw);
      await expectOneWakeup(res.payoutId!, "rejected", "awaiting_approval");
      expect((await allWakeups())[0].payload).toMatchObject({ code: "OVER_CAT_CAP" });
    });

    it("a caretaker's reject enqueues a wakeup, and a repeat does not", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await rejectPayout(res.payoutId!, caretakerId, "too much");
      await rejectPayout(res.payoutId!, caretakerId, "too much");
      await expectOneWakeup(res.payoutId!, "rejected", "awaiting_approval");
    });

    it("a reject whose wakeup cannot be written does not commit", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await blockWakeups(async () => {
        await expect(rejectPayout(res.payoutId!, caretakerId, "no")).rejects.toThrow();
      });
      expect((await payoutRow(res.payoutId!)).status).toBe("awaiting_approval");
    });

    it("a successful approval enqueues no wakeup for the move to sent", async () => {
      const gw = new FakeGateway();
      const res = await requestPayout(ask(w, 200001), gw);
      await approvePayout(res.payoutId!, caretakerId, gw);
      expect(await allWakeups()).toEqual([]);
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

      // A caretaker's no is final for the agent: asking again needs a person, not another row.
      const again = await requestPayout(ask(w, 200001), gw);
      expect(again).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
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

    it("the row's ids win over anything a caller put in inputs", async () => {
      await addPayout(w, { amount: 45000, status: "sent" });
      const res = await requestPayout(
        { ...ask(w), inputs: { bookingId: "forged", code: "forged" } },
        new FakeGateway(),
      );
      expect((await actionRow(res.actionId)).inputs).toMatchObject({
        bookingId: w.booking.id,
        code: "DUPLICATE_PAYOUT",
      });
    });

    it("concurrent approvals of old payouts cannot both fit today's cap", async () => {
      const a = await makeWorld();
      const b = await makeWorld();
      const pa = await addPayout(a, { amount: 150000, status: "awaiting_approval", createdAt: YESTERDAY() });
      const pb = await addPayout(b, { amount: 150000, status: "awaiting_approval", createdAt: YESTERDAY() });
      await setGuardrails({ maxPerDay: 200000 });
      const gw = new FakeGateway();
      // Holds each claim back, so the second approval's check always runs in the
      // gap between the first approval's commit and its claim.
      await db.execute(sql`
        create function slow_claim() returns trigger language plpgsql as
        $$ begin perform pg_sleep(0.3); return new; end $$
      `);
      await db.execute(sql`
        create trigger slow_claim before update on payouts for each row
        when (new.attempts > old.attempts) execute function slow_claim()
      `);
      let results;
      try {
        results = await Promise.all([
          approvePayout(pa.id, caretakerId, gw),
          approvePayout(pb.id, caretakerId, gw),
        ]);
      } finally {
        await db.execute(sql`drop trigger slow_claim on payouts`);
        await db.execute(sql`drop function slow_claim()`);
      }
      expect(gw.calls).toHaveLength(1);
      expect(results.map((r) => r.status).sort()).toEqual(["rejected", "sent"]);
      expect(results.find((r) => r.status === "rejected")?.code).toBe("OVER_DAY_CAP");
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

    it("keeps the last gateway error on the row, and enqueues nothing while still queued", async () => {
      const gw = new FakeGateway([{ kind: "unknown", error: "first" }, { kind: "unknown", error: "second" }]);
      const res = await requestPayout(ask(w), gw);
      expect((await payoutRow(res.payoutId!)).lastGatewayError).toBe("first");
      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      expect((await payoutRow(res.payoutId!)).lastGatewayError).toBe("second");
      expect(await allWakeups()).toEqual([]);
    });

    it("a late rejection from an older attempt is ignored", async () => {
      const sweepGw = new FakeGateway([UNKNOWN]);
      const gw = new FakeGateway([REJECTED]);
      gw.onCreate = async () => {
        await ageQueuedPayouts();
        await retryUnknownPayouts(sweepGw);
      };
      const res = await requestPayout(ask(w), gw);

      expect(res.status).toBe("queued");
      expect(sweepGw.calls[0].senderBatchId).toBe(res.payoutId);
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "queued",
        attempts: 2,
        lastGatewayError: UNKNOWN.error,
      });
      expect(await reserved()).toBe(45000);
      expect(await allWakeups()).toEqual([]);
    });

    it("a late unknown from an older attempt does not overwrite the newer error", async () => {
      const sweepGw = new FakeGateway([{ kind: "unknown", error: "newer" }]);
      const gw = new FakeGateway([{ kind: "unknown", error: "older" }]);
      gw.onCreate = async () => {
        await ageQueuedPayouts();
        await retryUnknownPayouts(sweepGw);
      };
      const res = await requestPayout(ask(w), gw);
      expect((await payoutRow(res.payoutId!)).lastGatewayError).toBe("newer");
    });

    it("a late sent from an older attempt is accepted while a newer attempt is unresolved", async () => {
      const sweepGw = new FakeGateway([UNKNOWN]);
      const gw = new FakeGateway([SENT("B-late")]);
      gw.onCreate = async () => {
        await ageQueuedPayouts();
        await retryUnknownPayouts(sweepGw);
      };
      const res = await requestPayout(ask(w), gw);

      expect(res.status).toBe("sent");
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "sent",
        attempts: 2,
        paypalPayoutBatchId: "B-late",
      });
      expect((await actionRow(res.actionId)).paypalRef).toBe("B-late");
    });

    it("a late sent is accepted from needs_review and stores its batch id", async () => {
      const sweepGw = new FakeGateway([REJECTED]);
      const gw = new FakeGateway([SENT("B-late")]);
      gw.onCreate = async () => {
        await ageQueuedPayouts();
        await retryUnknownPayouts(sweepGw);
        expect((await payoutRow(gw.calls[0].senderBatchId)).status).toBe("needs_review");
      };
      const res = await requestPayout(ask(w), gw);

      expect(res.status).toBe("sent");
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "sent",
        paypalPayoutBatchId: "B-late",
      });
      expect(await reserved()).toBe(45000);
      // One wakeup for the move to needs_review, none for the move to sent.
      await expectOneWakeup(res.payoutId!, "needs_review", "queued");
    });

    /** The caretaker rules not_paid while the first attempt's response is on its way. */
    function failedWhileInFlight(result: Parameters<FakeGateway["results"]["push"]>[0]) {
      const sweepGw = new FakeGateway([REJECTED]);
      const gw = new FakeGateway([result]);
      gw.onCreate = async (i) => {
        await ageQueuedPayouts();
        await retryUnknownPayouts(sweepGw);
        await db.execute(sql`
          update payouts set last_attempt_at = now() - interval '2 minutes' where id = ${i.senderBatchId}
        `);
        await resolveNeedsReview(i.senderBatchId, caretakerId, { outcome: "not_paid", note: "checked" });
        await db.delete(wakeups);
      };
      return gw;
    }

    it("a late sent on a failed row keeps the evidence and asks for a person, without reviving it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await requestPayout(ask(w), failedWhileInFlight(SENT("B-late")));

      expect(res.status).toBe("failed");
      const row = await payoutRow(res.payoutId!);
      expect(row).toMatchObject({ status: "failed", paypalPayoutBatchId: "B-late" });
      expect(row.lastGatewayError).toContain(BATCH_EXISTS_FLAG);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0][0])).toContain("B-late");
      const rows = await allWakeups();
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        payoutId: res.payoutId,
        status: "failed",
        alert: "batch_exists_after_failed",
        lateBatchId: "B-late",
      });
      error.mockRestore();
    });

    it("a duplicate with a batch id on a failed row is handled the same way", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await requestPayout(ask(w), failedWhileInFlight(DUPLICATE("B-dup")));
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "failed",
        paypalPayoutBatchId: "B-dup",
      });
      expect(await allWakeups()).toHaveLength(1);
      error.mockRestore();
    });

    it("a duplicate with no batch id on a failed row flags it and asks for a person", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await requestPayout(ask(w), failedWhileInFlight(DUPLICATE()));
      const row = await payoutRow(res.payoutId!);
      expect(row).toMatchObject({ status: "failed", paypalPayoutBatchId: null });
      expect(row.lastGatewayError).toBe(`${BATCH_EXISTS_FLAG}: ${DUPLICATE_ERROR}`);
      expect(await allWakeups()).toHaveLength(1);
      error.mockRestore();
    });

    it("a late sent repeating the batch a failed row already has is a no-op", async () => {
      const p = await addPayout(w, { amount: 1, status: "queued", attempts: 1, batchId: "B-same", createdAt: YESTERDAY() });
      const gw = new FakeGateway([SENT("B-same")]);
      gw.onCreate = async () => {
        await db.update(payouts).set({ status: "failed" }).where(eq(payouts.id, p.id));
      };
      await retryUnknownPayouts(gw);
      expect(await payoutRow(p.id)).toMatchObject({ status: "failed", lastGatewayError: null });
      expect(await allWakeups()).toEqual([]);
    });

    it("a late sent never replaces a different batch id on a failed row", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const p = await addPayout(w, { amount: 1, status: "queued", attempts: 1, batchId: "B-first", createdAt: YESTERDAY() });
      const gw = new FakeGateway([SENT("B-second")]);
      gw.onCreate = async () => {
        await db.update(payouts).set({ status: "failed" }).where(eq(payouts.id, p.id));
      };
      await retryUnknownPayouts(gw);
      const row = await payoutRow(p.id);
      expect(row).toMatchObject({ status: "failed", paypalPayoutBatchId: "B-first" });
      expect(row.lastGatewayError).toContain(BATCH_EXISTS_FLAG);
      expect(await allWakeups()).toHaveLength(1);
      error.mockRestore();
    });

    it("a late sent never stores a batch id already on another payout", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const w2 = await makeWorld();
      await addPayout(w2, { amount: 1, status: "sent", batchId: "B-taken" });
      const res = await requestPayout(ask(w), failedWhileInFlight(SENT("B-taken")));
      expect((await payoutRow(res.payoutId!)).paypalPayoutBatchId).toBeNull();
      expect(await allWakeups()).toHaveLength(1);
      error.mockRestore();
    });

    it("a late sent on a needs_review row with a different batch keeps the first", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const sweepGw = new FakeGateway([REJECTED]);
      const gw = new FakeGateway([SENT("B-second")]);
      gw.onCreate = async (i) => {
        await ageQueuedPayouts();
        await retryUnknownPayouts(sweepGw);
        await db.update(payouts).set({ paypalPayoutBatchId: "B-first" }).where(eq(payouts.id, i.senderBatchId));
      };
      const res = await requestPayout(ask(w), gw);
      expect(await payoutRow(res.payoutId!)).toMatchObject({
        status: "sent",
        paypalPayoutBatchId: "B-first",
      });
      expect((await actionRow(res.actionId)).paypalRef).toBe("B-first");
      expect(error).toHaveBeenCalledOnce();
      error.mockRestore();
    });

    describe("whatever live PayPal answers to a repeated sender_batch_id", () => {
      // PayPal documents no error for this (the schema only says the API "rejects the request with an error message
      // that shows the duplicate sender_batch_id"). The sandbox answer is parsed elsewhere; these are the replies
      // we cannot rule out on live. None of them may fail the payout, pay it again, or free its reservation.
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const REPLIES: [string, () => Response][] = [
        ["a 400 with an unfamiliar name", () => json(400, { name: "DUPLICATE_TRANSACTION", message: "m", details: [] })],
        ["a 422", () => json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ field: "sender_batch_header.sender_batch_id" }] })],
        ["a 403", () => json(403, { name: "NOT_AUTHORIZED" })],
        ["a 400 whose body is not JSON", () => new Response("<html>duplicate</html>", { status: 400 })],
      ];

      beforeEach(() => {
        clearPayPalTokenCache();
        vi.stubEnv("PAYPAL_CLIENT_ID", "id");
        vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
        vi.stubEnv("PAYPAL_ENV", "sandbox");
      });
      afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      });

      function livePayPal(payoutReplies: (() => Response)[]) {
        const queue = [...payoutReplies];
        const sent: string[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 3600 });
            sent.push(String(JSON.parse(String(init?.body)).sender_batch_header.sender_batch_id));
            const next = queue.shift();
            if (!next) throw new Error("unexpected extra payout call");
            return next();
          }),
        );
        return sent;
      }

      it.each(REPLIES)("on a retry, %s goes to needs_review, keeps the reservation and is never sent again", async (_n, reply) => {
        // The first send is lost (a timeout), the retry meets the reply.
        const sent = livePayPal([() => json(500, { name: "INTERNAL_SERVICE_ERROR" }), reply]);
        const res = await requestPayout(ask(w), restPayoutGateway);
        expect(res.status).toBe("queued");
        await ageQueuedPayouts();
        await retryUnknownPayouts(restPayoutGateway);

        const row = await payoutRow(res.payoutId!);
        expect(row.status).toBe("needs_review");
        expect(row.attempts).toBe(2);
        expect(await reserved()).toBe(45000);
        await expectOneWakeup(res.payoutId!, "needs_review", "queued");
        // Both sends carried the one id, and nothing is sent after review begins.
        expect(sent).toEqual([res.payoutId, res.payoutId]);
        await ageQueuedPayouts();
        await retryUnknownPayouts(restPayoutGateway);
        expect(sent).toHaveLength(2);
        // Nor can the booking be asked for a second time while this one is live.
        const again = await requestPayout(ask(w), new FakeGateway());
        expect(again).toMatchObject({ status: "rejected", code: "DUPLICATE_PAYOUT" });
        expect(await db.select().from(payouts)).toHaveLength(1);
      });

      it("on a first attempt the same replies are a refusal that never reached PayPal's books, so failed is still right", async () => {
        livePayPal([() => json(422, { name: "UNPROCESSABLE_ENTITY" })]);
        const res = await requestPayout(ask(w), restPayoutGateway);
        expect(res.status).toBe("failed");
        expect(await reserved()).toBe(0);
      });
    });

    describe("duplicate results", () => {
      it("on a retry, a batch id moves the row to sent, and reconcile settles it for real", async () => {
        const gw = new FakeGateway([UNKNOWN, DUPLICATE("B-dup")]);
        const res = await requestPayout(ask(w), gw);
        await ageQueuedPayouts();
        await retryUnknownPayouts(gw);

        expect(await payoutRow(res.payoutId!)).toMatchObject({
          status: "sent",
          paypalPayoutBatchId: "B-dup",
          lastGatewayError: DUPLICATE_ERROR,
        });
        expect((await actionRow(res.actionId)).paypalRef).toBe("B-dup");
        expect(await reserved()).toBe(45000);
        expect(await allWakeups()).toEqual([]);

        gw.statuses.set("B-dup", { batchStatus: "SUCCESS", itemStatus: "SUCCESS", itemId: "I", fee: 100 });
        await reconcilePayouts(gw);
        expect(await payoutRow(res.payoutId!)).toMatchObject({ status: "succeeded", fee: 100 });
      });

      it("on a first attempt, a batch id also moves the row to sent, never failed", async () => {
        const res = await requestPayout(ask(w), new FakeGateway([DUPLICATE("B-dup")]));
        expect(res.status).toBe("sent");
        expect(await payoutRow(res.payoutId!)).toMatchObject({
          status: "sent",
          attempts: 1,
          paypalPayoutBatchId: "B-dup",
        });
      });

      it("on a retry, no batch id goes to needs_review, flagged, and not_paid is refused", async () => {
        const gw = new FakeGateway([UNKNOWN, DUPLICATE()]);
        const res = await requestPayout(ask(w), gw);
        await ageQueuedPayouts();
        await retryUnknownPayouts(gw);

        const row = await payoutRow(res.payoutId!);
        expect(row.status).toBe("needs_review");
        expect(row.lastGatewayError).toBe(`${BATCH_EXISTS_FLAG}: ${DUPLICATE_ERROR}`);
        expect(await reserved()).toBe(45000);
        await expectOneWakeup(res.payoutId!, "needs_review", "queued");

        await db.execute(sql`update payouts set last_attempt_at = now() - interval '1 hour'`);
        await expect(
          resolveNeedsReview(res.payoutId!, caretakerId, { outcome: "not_paid", note: "x" }),
        ).rejects.toThrow(/already exists/i);
      });

      it("on a first attempt, no batch id also goes to needs_review, never failed", async () => {
        const res = await requestPayout(ask(w), new FakeGateway([DUPLICATE()]));
        expect(res.status).toBe("needs_review");
        expect(await reserved()).toBe(45000);
        expect((await payoutRow(res.payoutId!)).lastGatewayError).toContain(BATCH_EXISTS_FLAG);
      });

      it("from an older attempt, no batch id still flags a row already under review", async () => {
        const sweepGw = new FakeGateway([REJECTED]);
        const gw = new FakeGateway([DUPLICATE()]);
        gw.onCreate = async () => {
          await ageQueuedPayouts();
          await retryUnknownPayouts(sweepGw);
        };
        const res = await requestPayout(ask(w), gw);
        expect((await payoutRow(res.payoutId!)).lastGatewayError).toContain(BATCH_EXISTS_FLAG);
        // Only the move to needs_review woke anyone.
        await expectOneWakeup(res.payoutId!, "needs_review", "queued");
      });

      it("from an older attempt, no batch id moves a still queued row to needs_review", async () => {
        const sweepGw = new FakeGateway([UNKNOWN]);
        const gw = new FakeGateway([DUPLICATE()]);
        gw.onCreate = async () => {
          await ageQueuedPayouts();
          await retryUnknownPayouts(sweepGw);
        };
        const res = await requestPayout(ask(w), gw);
        expect(res.status).toBe("needs_review");
      });

      it("no batch id does not disturb a row already sent", async () => {
        const sweepGw = new FakeGateway([SENT("B-1")]);
        const gw = new FakeGateway([DUPLICATE()]);
        gw.onCreate = async () => {
          await ageQueuedPayouts();
          await retryUnknownPayouts(sweepGw);
        };
        const res = await requestPayout(ask(w), gw);
        expect(res.status).toBe("sent");
        expect((await payoutRow(res.payoutId!)).paypalPayoutBatchId).toBe("B-1");
      });
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
      await expectOneWakeup(res.payoutId!, "needs_review", "queued");
    });

    it("a gateway outcome whose wakeup cannot be written does not commit", async () => {
      const gw = new FakeGateway([REJECTED]);
      const p = await addPayout(w, { amount: 45000, status: "queued", createdAt: YESTERDAY() });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await blockWakeups(() => retryUnknownPayouts(gw));
      expect((await payoutRow(p.id)).status).toBe("queued");
      error.mockRestore();
    });

    it("a retry's rejection enqueues one needs_review wakeup", async () => {
      const gw = new FakeGateway([UNKNOWN, REJECTED]);
      const res = await requestPayout(ask(w), gw);
      await ageQueuedPayouts();
      await retryUnknownPayouts(gw);
      await expectOneWakeup(res.payoutId!, "needs_review", "queued");
      expect((await payoutRow(res.payoutId!)).lastGatewayError).toBe(REJECTED.error);
    });

    it("retries running out enqueues one needs_review wakeup", async () => {
      const gw = new FakeGateway(Array.from({ length: 6 }, () => UNKNOWN));
      const res = await requestPayout(ask(w), gw);
      for (let retry = 1; retry <= 5; retry++) {
        await ageQueuedPayouts();
        await retryUnknownPayouts(gw);
      }
      await expectOneWakeup(res.payoutId!, "needs_review", "queued");
    });

    it("a sender that died on its last attempt enqueues one needs_review wakeup", async () => {
      const p = await addPayout(w, {
        amount: 45000,
        status: "queued",
        attempts: 6,
        createdAt: YESTERDAY(),
      });
      await retryUnknownPayouts(new FakeGateway());
      await expectOneWakeup(p.id, "needs_review", "queued");
    });

    it("a first attempt that fails through the sweep enqueues a wakeup", async () => {
      const p = await addPayout(w, {
        amount: 45000,
        status: "queued",
        createdAt: YESTERDAY(),
      });
      await retryUnknownPayouts(new FakeGateway([REJECTED]));
      await expectOneWakeup(p.id, "failed", "queued");
    });

    it("one row failing cannot stop the sweep", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const w2 = await makeWorld();
      const longAgo = new Date(Date.now() - 7_200_000);
      const bad = await addPayout(w, { amount: 1, status: "queued", createdAt: longAgo });
      const good = await addPayout(w2, { amount: 1, status: "queued", createdAt: YESTERDAY() });
      // Oldest first, and Postgres refuses a NUL in text, so recording this result throws.
      await db.update(payouts).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(payouts.id, bad.id));
      const gw = new FakeGateway([SENT("bad\u0000id"), SENT("B-good")]);

      await expect(retryUnknownPayouts(gw)).resolves.toBeUndefined();
      expect(gw.calls.map((c) => c.senderBatchId)).toEqual([bad.id, good.id]);
      expect((await payoutRow(bad.id)).status).toBe("queued");
      expect((await payoutRow(good.id)).status).toBe("sent");
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0][0])).toContain(bad.id);
      error.mockRestore();
    });
  });

  describe("resolveNeedsReview", () => {
    async function underReview(world: World = w, batchId?: string) {
      return addPayout(world, { amount: 45000, status: "needs_review", attempts: 2, batchId });
    }
    const auditRows = () =>
      db.select().from(agentActions).where(eq(agentActions.action, "payout_review_resolved"));

    it("paid sets succeeded, records the reference, keeps the money counted, and audits", async () => {
      const p = await underReview();
      const res = await resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: " PB-REAL " });
      expect(res).toMatchObject({ status: "succeeded", payoutId: p.id });
      expect(await payoutRow(p.id)).toMatchObject({
        status: "succeeded",
        paypalPayoutBatchId: "PB-REAL",
      });
      expect(await actionRow(p.actionId)).toMatchObject({ status: "succeeded", paypalRef: "PB-REAL" });

      const [audit] = await auditRows();
      expect(audit).toMatchObject({
        status: "succeeded",
        approvedBy: caretakerId,
        paypalRef: "PB-REAL",
        amount: 45000,
      });
      expect(audit.inputs).toMatchObject({ payoutId: p.id, outcome: "paid", paypalRef: "PB-REAL" });

      const status = await withColonyLock(getPoolStatus);
      expect(status).toMatchObject({ vetPaid: 45000, reservedPayouts: 0 });
      await expectOneWakeup(p.id, "succeeded", "needs_review");
    });

    it("not_paid sets failed, frees the reservation, and audits the note", async () => {
      const p = await underReview();
      expect(await reserved()).toBe(45000);
      const res = await resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note: "No batch in PayPal" });
      expect(res.status).toBe("failed");
      expect((await payoutRow(p.id)).status).toBe("failed");
      expect(await reserved()).toBe(0);
      const [audit] = await auditRows();
      expect(audit).toMatchObject({ status: "failed", approvedBy: caretakerId });
      expect(audit.inputs).toMatchObject({ outcome: "not_paid", note: "No batch in PayPal" });
      await expectOneWakeup(p.id, "failed", "needs_review");
      expect((await requestPayout(ask(w), new FakeGateway())).status).toBe("sent");
    });

    describe("not_paid cannot free money that has left", () => {
      async function expectRefused(p: { id: string }, pattern: RegExp) {
        await expect(
          resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note: "x" }),
        ).rejects.toThrow(pattern);
        expect((await payoutRow(p.id)).status).toBe("needs_review");
        expect(await auditRows()).toEqual([]);
        expect(await allWakeups()).toEqual([]);
        expect(await reserved()).toBe(45000);
      }
      async function expectPaidStillAllowed(p: { id: string }) {
        const res = await resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: "PB-X" });
        expect(res.status).toBe("succeeded");
      }
      const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

      it("refuses when a batch id is set; paid stays allowed", async () => {
        const p = await underReview(w, "PB-1");
        await expectRefused(p, /has a PayPal batch/);
        await expectPaidStillAllowed(p);
      });

      it("refuses when a send may be in flight; paid stays allowed", async () => {
        expect(IN_FLIGHT_WINDOW_SECONDS).toBe(60);
        const p = await addPayout(w, {
          amount: 45000,
          status: "needs_review",
          attempts: 2,
          lastAttemptAt: secondsAgo(IN_FLIGHT_WINDOW_SECONDS - 5),
        });
        await expectRefused(p, /in flight/);
        await expectPaidStillAllowed(p);
      });

      it("allows once the in-flight window has passed", async () => {
        const p = await addPayout(w, {
          amount: 45000,
          status: "needs_review",
          attempts: 2,
          lastAttemptAt: secondsAgo(IN_FLIGHT_WINDOW_SECONDS + 5),
        });
        const res = await resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note: "x" });
        expect(res.status).toBe("failed");
      });

      it("refuses when PayPal said the batch exists; paid stays allowed", async () => {
        const p = await underReview();
        await db
          .update(payouts)
          .set({ lastGatewayError: `${BATCH_EXISTS_FLAG}: ${DUPLICATE_ERROR}` })
          .where(eq(payouts.id, p.id));
        await expectRefused(p, /already exists/);
        await expectPaidStillAllowed(p);
      });

      it("allows after an ordinary gateway error", async () => {
        const p = await underReview();
        await db.update(payouts).set({ lastGatewayError: REJECTED.error }).where(eq(payouts.id, p.id));
        const res = await resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note: "x" });
        expect(res.status).toBe("failed");
      });
    });

    it("paid keeps a batch id from PayPal, with the typed reference in the audit row", async () => {
      const p = await underReview(w, "PB-REAL");
      await resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: "TYPED" });
      expect(await payoutRow(p.id)).toMatchObject({ status: "succeeded", paypalPayoutBatchId: "PB-REAL" });
      const [audit] = await auditRows();
      expect(audit.paypalRef).toBe("TYPED");
      expect(audit.inputs).toMatchObject({ paypalRef: "TYPED", previousBatchId: "PB-REAL" });
    });

    describe("a settle that commits between the read and the write", () => {
      /**
       * Holds the row with an uncommitted move to sent, so the resolve can read
       * needs_review but blocks at its update. Committing then lands exactly in
       * that gap, and Postgres re-checks the update's conditions on the new row.
       */
      async function interleave(payoutId: string, resolve: () => Promise<{ status: string }>) {
        const pool = createTestPool();
        const settler: PoolClient = await pool.connect();
        try {
          await settler.query("begin");
          await settler.query(
            "update payouts set status = 'sent', paypal_payout_batch_id = 'B-settled' where id = $1",
            [payoutId],
          );
          const pending = resolve();
          for (let i = 0; i < 200; i++) {
            const { rows } = await pool.query(
              `select 1 from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'
                 and query like 'update "payouts"%'`,
            );
            if (rows.length > 0) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          await settler.query("commit");
          return await pending;
        } finally {
          settler.release();
          await closeTestPool(pool);
        }
      }

      it.each([
        ["paid", { outcome: "paid" as const, paypalRef: "TYPED" }],
        ["not_paid", { outcome: "not_paid" as const, note: "x" }],
      ])("%s does nothing and the batch id survives", async (_name, ruling) => {
        const p = await underReview();
        const res = await interleave(p.id, () => resolveNeedsReview(p.id, caretakerId, ruling));

        expect(res.status).toBe("sent");
        expect(await payoutRow(p.id)).toMatchObject({
          status: "sent",
          paypalPayoutBatchId: "B-settled",
        });
        expect((await actionRow(p.actionId)).status).toBe("needs_review");
        expect(await auditRows()).toEqual([]);
        expect(await allWakeups()).toEqual([]);
      });
    });

    it.each(["", "   "])("not_paid with note %j throws and changes nothing", async (note) => {
      const p = await underReview();
      await expect(
        resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note }),
      ).rejects.toThrow(/note/i);
      expect((await payoutRow(p.id)).status).toBe("needs_review");
      expect(await auditRows()).toEqual([]);
    });

    it("paid with an empty reference throws", async () => {
      const p = await underReview();
      await expect(
        resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: " " }),
      ).rejects.toThrow(/reference/i);
      expect((await payoutRow(p.id)).status).toBe("needs_review");
    });

    it("refuses a reference already on another payout", async () => {
      const w2 = await makeWorld();
      await addPayout(w2, { amount: 1, status: "sent", batchId: "PB-TAKEN" });
      const p = await underReview();
      await expect(
        resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: "PB-TAKEN" }),
      ).rejects.toThrow(/another payout/i);
      expect((await payoutRow(p.id)).status).toBe("needs_review");
    });

    it("a second resolve is a no-op", async () => {
      const p = await underReview();
      await resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: "PB-1" });
      const again = await resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note: "changed my mind" });
      expect(again.status).toBe("succeeded");
      expect(await payoutRow(p.id)).toMatchObject({ status: "succeeded", paypalPayoutBatchId: "PB-1" });
      expect(await auditRows()).toHaveLength(1);
      expect(await allWakeups()).toHaveLength(1);
    });

    it.each(["awaiting_approval", "queued", "sent", "succeeded", "failed", "rejected"])(
      "only acts from needs_review, not %s",
      async (status) => {
        const p = await addPayout(w, { amount: 1, status });
        const res = await resolveNeedsReview(p.id, caretakerId, { outcome: "not_paid", note: "x" });
        expect(res.status).toBe(status);
        expect((await payoutRow(p.id)).status).toBe(status);
        expect(await auditRows()).toEqual([]);
      },
    );

    it("only a caretaker can resolve", async () => {
      const p = await underReview();
      await expect(
        resolveNeedsReview(p.id, w.vet.id, { outcome: "not_paid", note: "x" }),
      ).rejects.toThrow(/caretaker/i);
      expect((await payoutRow(p.id)).status).toBe("needs_review");
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

    it.each(["BLOCKED", "REVERSED"])("%s is not proven final, so a sent payout goes to review and keeps its reservation", async (itemStatus) => {
      const p = await sentPayout();
      await applyPayoutStatus("B-9", { itemStatus });
      expect((await payoutRow(p.id)).status).toBe("needs_review");
      expect(await reserved()).toBe(45000);
      expect(await allWakeups()).toHaveLength(1);
    });

    it.each(["FAILED", "RETURNED", "REFUNDED", "CANCELED"])(
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

    it("cannot move a rejected payout", async () => {
      const rejected = await addPayout(w, { amount: 1, status: "rejected", batchId: "R-2" });
      await applyPayoutStatus("R-2", { itemStatus: "SUCCESS" });
      expect((await payoutRow(rejected.id)).status).toBe("rejected");
      expect(await allWakeups()).toEqual([]);
    });

    describe("lookup by sender batch id", () => {
      it("attaches the real batch id to a needs_review row and settles it on SUCCESS", async () => {
        const p = await addPayout(w, { amount: 45000, status: "needs_review", attempts: 2 });
        await applyPayoutStatus("PB-REAL", {
          senderBatchId: p.id,
          itemStatus: "SUCCESS",
          itemId: "I-1",
          fee: 2500,
        });
        expect(await payoutRow(p.id)).toMatchObject({
          status: "succeeded",
          paypalPayoutBatchId: "PB-REAL",
          paypalItemId: "I-1",
          fee: 2500,
        });
        expect((await actionRow(p.actionId)).paypalRef).toBe("PB-REAL");
        await expectOneWakeup(p.id, "succeeded", "needs_review");
      });

      it("settles a needs_review row as failed on a failing status, freeing the money", async () => {
        const p = await addPayout(w, { amount: 45000, status: "needs_review", attempts: 2 });
        await applyPayoutStatus("PB-REAL", { senderBatchId: p.id, itemStatus: "FAILED" });
        expect(await payoutRow(p.id)).toMatchObject({ status: "failed", paypalPayoutBatchId: "PB-REAL" });
        expect(await reserved()).toBe(0);
      });

      it("a pending status attaches the batch id but leaves the review open", async () => {
        const p = await addPayout(w, { amount: 45000, status: "needs_review", attempts: 2 });
        await applyPayoutStatus("PB-REAL", { senderBatchId: p.id, itemStatus: "PENDING" });
        expect(await payoutRow(p.id)).toMatchObject({
          status: "needs_review",
          paypalPayoutBatchId: "PB-REAL",
        });
        expect(await allWakeups()).toEqual([]);
        expect(await reserved()).toBe(45000);
      });

      it("a status that beats the recording of sent attaches the batch id to the queued row", async () => {
        const p = await addPayout(w, { amount: 45000, status: "queued", attempts: 1 });
        await applyPayoutStatus("PB-REAL", { senderBatchId: p.id, itemStatus: "SUCCESS" });
        expect(await payoutRow(p.id)).toMatchObject({ status: "queued", paypalPayoutBatchId: "PB-REAL" });
        expect(await allWakeups()).toEqual([]);
      });

      it("does not overwrite the batch id of a settled payout", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const p = await addPayout(w, { amount: 45000, status: "sent", batchId: "PB-1" });
        await applyPayoutStatus("PB-OTHER", { senderBatchId: p.id, itemStatus: "SUCCESS" });
        expect(await payoutRow(p.id)).toMatchObject({ status: "succeeded", paypalPayoutBatchId: "PB-1" });
        expect(error).toHaveBeenCalledOnce();
        error.mockRestore();
      });

      it.each(["queued", "needs_review"])(
        "never overwrites a different batch id on a %s row",
        async (status) => {
          const error = vi.spyOn(console, "error").mockImplementation(() => {});
          const p = await addPayout(w, { amount: 45000, status, attempts: 2, batchId: "PB-1" });
          await applyPayoutStatus("PB-OTHER", { senderBatchId: p.id, itemStatus: "PENDING" });
          expect((await payoutRow(p.id)).paypalPayoutBatchId).toBe("PB-1");
          expect(error).toHaveBeenCalledOnce();
          error.mockRestore();
        },
      );

      it("refuses a batch id already on another payout, logs, and changes neither", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const w2 = await makeWorld();
        const owner = await addPayout(w2, { amount: 1, status: "sent", batchId: "PB-TAKEN" });
        const p = await addPayout(w, { amount: 45000, status: "needs_review", attempts: 2 });
        await applyPayoutStatus("PB-TAKEN", { senderBatchId: p.id, itemStatus: "SUCCESS" });
        expect(await payoutRow(p.id)).toMatchObject({ status: "needs_review", paypalPayoutBatchId: null });
        expect((await payoutRow(owner.id)).status).toBe("sent");
        expect(error).toHaveBeenCalledOnce();
        expect(String(error.mock.calls[0][0])).toContain("PB-TAKEN");
        expect(await allWakeups()).toEqual([]);
        error.mockRestore();
      });

      it("finds a settled payout whose batch id came from a person, so a return still counts", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const p = await addPayout(w, { amount: 45000, status: "needs_review", attempts: 2 });
        await resolveNeedsReview(p.id, caretakerId, { outcome: "paid", paypalRef: "TYPED" });
        await applyPayoutStatus("PB-REAL", { senderBatchId: p.id, itemStatus: "RETURNED" });
        expect(await payoutRow(p.id)).toMatchObject({ status: "failed", paypalPayoutBatchId: "TYPED" });
        error.mockRestore();
      });

      it("falls back to the batch id when the sender id matches nothing, even if malformed", async () => {
        const p = await addPayout(w, { amount: 45000, status: "sent", batchId: "PB-1" });
        await applyPayoutStatus("PB-1", { senderBatchId: "not-a-uuid", itemStatus: "SUCCESS" });
        expect((await payoutRow(p.id)).status).toBe("succeeded");
        await expect(
          applyPayoutStatus("nope", { senderBatchId: "not-a-uuid", itemStatus: "SUCCESS" }),
        ).resolves.toBeUndefined();
      });
    });

    it.each([Number.NaN, 10.5, -1])("a fee of %s cannot block the status change", async (fee) => {
      const p = await sentPayout();
      await applyPayoutStatus("B-9", { itemStatus: "SUCCESS", fee });
      expect(await payoutRow(p.id)).toMatchObject({ status: "succeeded", fee: null });
    });

    it("ignores an unknown batch id", async () => {
      await expect(applyPayoutStatus("nope", { itemStatus: "SUCCESS" })).resolves.toBeUndefined();
      expect(await allWakeups()).toEqual([]);
    });

    it("rolls back the status when the wakeup cannot be written", async () => {
      const p = await sentPayout();
      await blockWakeups(async () => {
        await expect(applyPayoutStatus("B-9", { itemStatus: "SUCCESS" })).rejects.toThrow();
      });
      expect((await payoutRow(p.id)).status).toBe("sent");
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

    it("polls a needs_review row with a batch id and settles it from the real status", async () => {
      const w2 = await makeWorld();
      const known = await addPayout(w, { amount: 1, status: "needs_review", attempts: 2, batchId: "A" });
      const blind = await addPayout(w2, { amount: 1, status: "needs_review", attempts: 2 });
      const gw = new FakeGateway();
      const get = vi.spyOn(gw, "get");
      gw.statuses.set("A", { batchStatus: "SUCCESS", itemStatus: "SUCCESS", fee: 100 });
      await reconcilePayouts(gw);
      expect(get.mock.calls.map((c) => c[0])).toEqual(["A"]);
      expect(await payoutRow(known.id)).toMatchObject({ status: "succeeded", fee: 100 });
      expect((await payoutRow(blind.id)).status).toBe("needs_review");
    });

    it("one row that cannot be applied does not stop the others, and is logged", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const w2 = await makeWorld();
      await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      await addPayout(w2, { amount: 1, status: "sent", batchId: "B" });
      const gw = new FakeGateway();
      const nul = { batchStatus: "SUCCESS", itemStatus: "SUCCESS", itemId: "bad\u0000id" };
      gw.statuses.set("A", nul);
      gw.statuses.set("B", nul);
      await expect(reconcilePayouts(gw)).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(2);
      expect(String(error.mock.calls[0][0])).toMatch(/batch [AB]/);
      error.mockRestore();
    });

    it("a failed poll is logged, with no details from the error", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await addPayout(w, { amount: 1, status: "sent", batchId: "A" });
      const gw = new FakeGateway();
      gw.statuses.set("A", new Error("vet@example.test"));
      await reconcilePayouts(gw);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0][0])).toContain("batch A");
      expect(String(error.mock.calls[0][0])).not.toContain("@");
      error.mockRestore();
    });

    it("one failed poll does not stop the others", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
      error.mockRestore();
    });
  });
});

describe("the retry block is enforced by the gate itself", () => {
  async function blockedWorld() {
    const w = await makeWorld();
    const failed = await addPayout(w, { amount: 45000, status: "failed", batchId: "B-X" });
    await db.update(payouts).set({ lastGatewayError: `${BATCH_EXISTS_FLAG}: HTTP 400` }).where(eq(payouts.id, failed.id));
    return w;
  }

  it("requestPayout refuses without the agent's own check", async () => {
    const w = await blockedWorld();
    const gw = new FakeGateway();
    const r = await requestPayout({ ...ask(w), reason: "Again.", inputs: {} }, gw);
    expect(r).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
    expect(gw.calls).toHaveLength(0);
    expect(await db.select().from(payouts).where(eq(payouts.bookingId, w.booking.id))).toHaveLength(1);
  });

  it("approvePayout refuses a waiting row whose booking has become blocked, and sends nothing", async () => {
    const w = await makeWorld();
    const waiting = await addPayout(w, { amount: 45000, status: "awaiting_approval" });
    const failed = await addPayout(w, { amount: 45000, status: "failed", batchId: "B-X" });
    await db.update(payouts).set({ lateSuccessReviewId: null, lastGatewayError: `${BATCH_EXISTS_FLAG}: HTTP 400` }).where(eq(payouts.id, failed.id));
    const care = await makeCaretaker();
    const gw = new FakeGateway();
    const r = await approvePayout(waiting.id, care.id, gw);
    expect(r).toMatchObject({ status: "rejected", code: "REVIEW_REQUIRED" });
    expect(gw.calls).toHaveLength(0);
    expect((await db.select().from(payouts).where(eq(payouts.id, waiting.id)))[0].status).toBe("rejected");
  });
});
