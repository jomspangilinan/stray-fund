import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { aiUsage, agentActions, allocations, cats, donations, payouts, reviewRequests, wakeups } from "../src/server/db/schema";
import {
  DEVELOP_PER_TICK,
  MAX_WAKEUP_ATTEMPTS,
  claimNextWakeup,
  failStaleWakeups,
  processNextWakeup,
  runMaintenance,
  runWorkerLoops,
} from "../src/server/agent/worker";
import { consumeAiBudget } from "../src/server/ai/budget";
import { truncateAll } from "./helpers/db";
import { FakeGateway, addPayout, makeBooking, makeVet } from "./helpers/payoutFixtures";
import { scriptedClient, type ScriptedTurn } from "./helpers/scriptedClient";

const enqueue = async (kind = "donation_captured", payload: object = { donationId: "d" }) => {
  const [w] = await db.insert(wakeups).values({ kind, payload }).returning();
  return w;
};
const row = async (id: string) => (await db.select().from(wakeups).where(eq(wakeups.id, id)))[0];
const makeDue = () => db.execute(sql`update wakeups set run_after = now() where status = 'pending'`);

function deps(turns: ScriptedTurn[], gw = new FakeGateway()) {
  const script = scriptedClient(turns);
  return {
    script,
    gw,
    deps: {
      client: script.client,
      gateway: gw,
      loadToolkit: async () => [],
      consumeBudget: async () => true,
    },
  };
}

async function bookedCat() {
  const vet = await makeVet();
  const [cat] = await db
    .insert(cats)
    .values({ name: "Mimi", areaName: "Brgy 1", status: "booked" })
    .returning();
  const booking = await makeBooking(cat.id, vet.id);
  return { vet, cat, booking };
}

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(closePool);

describe("claiming", () => {
  it("worker: two workers claim a wakeup once", async () => {
    await enqueue();
    const claims = await Promise.all([claimNextWakeup(), claimNextWakeup(), claimNextWakeup()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("two workers with two wakeups of different kinds each get their own", async () => {
    await enqueue("donation_captured");
    await enqueue("cat_queued");
    const [a, b] = await Promise.all([claimNextWakeup(), claimNextWakeup()]);
    expect(a && b && a.id !== b.id).toBe(true);
  });

  it("claims the oldest first, one at a time", async () => {
    const old = await enqueue("donation_captured");
    await enqueue("cat_queued");
    expect((await claimNextWakeup())?.id).toBe(old.id);
  });

  it("the claim is committed as running before the model is called", async () => {
    const w = await enqueue();
    let seen: string | undefined;
    const { deps: d } = deps([
      {
        text: "ok",
        before: async () => {
          seen = (await row(w.id)).status;
        },
      },
    ]);
    await processNextWakeup(d);
    expect(seen).toBe("running");
    expect((await row(w.id)).status).toBe("done");
  });

  it("returns false with nothing to do", async () => {
    const { deps: d } = deps([]);
    expect(await processNextWakeup(d)).toBe(false);
  });
});

describe("retries", () => {
  const failing = () => Array.from({ length: 5 }, () => new Error("bedrock down"));

  it("worker: failing wakeup retries and stops at 3, then shows on the caretaker queue", async () => {
    const w = await enqueue();
    const { script, deps: d } = deps(failing());

    for (let i = 1; i <= MAX_WAKEUP_ATTEMPTS; i++) {
      await makeDue();
      expect(await processNextWakeup(d)).toBe(true);
      expect((await row(w.id)).attempts).toBe(i);
    }

    expect(MAX_WAKEUP_ATTEMPTS).toBe(3);
    expect((await row(w.id)).status).toBe("failed");
    const reviews = await db.select().from(reviewRequests);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).toBe("open");
    expect(reviews[0].reason).not.toContain("bedrock down");

    await makeDue();
    expect(await processNextWakeup(d)).toBe(false);
    expect(script.requests).toHaveLength(3);
  });

  it("a failed attempt backs off before it can be claimed again", async () => {
    const w = await enqueue();
    const { deps: d } = deps(failing());
    await processNextWakeup(d);
    const after = await row(w.id);
    expect(after.status).toBe("pending");
    expect(after.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(await claimNextWakeup()).toBeNull();
  });

  it("worker: max_iterations reached ends the run safely and retries by the same rules", async () => {
    const w = await enqueue();
    const turns = Array.from({ length: 12 }, () => ({
      calls: [{ name: "get_pool_status", input: {} }],
    }));
    const { script, deps: d } = deps(turns);
    await processNextWakeup(d);
    expect(script.requests).toHaveLength(12);
    expect((await row(w.id)).status).toBe("pending");
    expect((await row(w.id)).attempts).toBe(1);
  });

  it("a refusal is not retried: the wakeup fails and goes to a person", async () => {
    const w = await enqueue();
    const { script, deps: d } = deps([{ stop: "refusal" }, { text: "never" }]);
    await processNextWakeup(d);
    expect((await row(w.id)).status).toBe("failed");
    expect(script.requests).toHaveLength(1);
    expect(await db.select().from(reviewRequests)).toHaveLength(1);
  });

  it("the caretaker queue gets one row however often the same kind gives out", async () => {
    for (let i = 0; i < 2; i++) {
      await enqueue();
      const { deps: d } = deps([{ stop: "refusal" }]);
      await processNextWakeup(d);
    }
    expect(await db.select().from(reviewRequests)).toHaveLength(1);
  });

  it("the real budget table counts one unit per turn", async () => {
    await enqueue();
    const { deps: d } = deps([
      { calls: [{ name: "get_pool_status", input: {} }] },
      { text: "done" },
    ]);
    await processNextWakeup({ ...d, consumeBudget: consumeAiBudget });
    const [usage] = await db.select().from(aiUsage);
    expect(usage.calls).toBe(2);
  });
});

describe("crash recovery", () => {
  const claimAndAge = async (minutes: number, attempts = 1) => {
    const w = await enqueue();
    await db.execute(sql`
      update wakeups set status = 'running', attempts = ${attempts},
        claimed_at = now() - make_interval(mins => ${minutes})
      where id = ${w.id}
    `);
    return w;
  };

  it("a wakeup left running beyond 10 minutes is reclaimed", async () => {
    const w = await claimAndAge(11);
    const claim = await claimNextWakeup();
    expect(claim?.id).toBe(w.id);
    expect(claim?.attempts).toBe(2);
  });

  it("one running for under 10 minutes is left alone", async () => {
    await claimAndAge(9);
    expect(await claimNextWakeup()).toBeNull();
  });

  it("a stale wakeup with no attempts left fails and goes to the caretaker", async () => {
    const w = await claimAndAge(11, 3);
    expect(await claimNextWakeup()).toBeNull();
    await failStaleWakeups();
    expect((await row(w.id)).status).toBe("failed");
    expect(await db.select().from(reviewRequests)).toHaveLength(1);
  });
});

describe("coalescing", () => {
  it("several pending wakeups of one kind make one run", async () => {
    const a = await enqueue("donation_captured", { donationId: "d1", net: 1 });
    const b = await enqueue("donation_captured", { donationId: "d2", net: 2 });
    const c = await enqueue("donation_captured", { donationId: "d3", net: 3 });
    const other = await enqueue("cat_queued", { catId: "c" });
    const { script, deps: d } = deps([{ text: "ok" }]);

    await processNextWakeup(d);

    expect(script.requests).toHaveLength(1);
    expect((await row(a.id)).status).toBe("done");
    expect((await row(b.id)).status).toBe("done");
    expect((await row(c.id)).status).toBe("done");
    expect((await row(other.id)).status).toBe("pending");
    const text = JSON.stringify(script.requests[0].messages);
    for (const id of ["d1", "d2", "d3"]) expect(text).toContain(id);
  });

  it("absorbed facts survive a failed run on the claimed row", async () => {
    const a = await enqueue("payout_status_changed", { payoutId: "p1", status: "failed" });
    await enqueue("payout_status_changed", { payoutId: "p2", status: "failed", alert: "batch_exists_after_failed" });
    const { script, deps: d } = deps([new Error("down"), { text: "ok", calls: [] }]);

    await processNextWakeup(d);
    expect((await row(a.id)).status).toBe("pending");
    await makeDue();
    await processNextWakeup(d);

    expect(JSON.stringify(script.requests[1].messages)).toContain("batch_exists_after_failed");
  });
});

describe("payout wakeups", () => {
  it("moves the cat into care deterministically, whatever the model does", async () => {
    const w = await bookedCat();
    const payout = await addPayout(w, { amount: 45000, status: "succeeded" });
    const wake = await enqueue("payout_status_changed", { payoutId: payout.id, kind: "deposit", status: "succeeded" });
    const { deps: d } = deps([{ text: "Nothing for me to do." }]);

    await processNextWakeup(d);

    expect((await db.select().from(cats).where(eq(cats.id, w.cat.id)))[0].status).toBe("in_care");
    expect((await row(wake.id)).status).toBe("done");
  });

  it("syncs every coalesced payout, not just the claimed one", async () => {
    const one = await bookedCat();
    const two = await bookedCat();
    const p1 = await addPayout(one, { amount: 45000, status: "succeeded" });
    const p2 = await addPayout(two, { amount: 45000, status: "sent" });
    await enqueue("payout_status_changed", { payoutId: p1.id });
    await enqueue("payout_status_changed", { payoutId: p2.id });
    const { deps: d } = deps([{ text: "ok" }]);
    await processNextWakeup(d);
    const statuses = (await db.select().from(cats)).map((c) => c.status);
    expect(statuses).toEqual(["in_care", "in_care"]);
  });

  it("a failing sync does not lose the wakeup", async () => {
    const wake = await enqueue("payout_status_changed", { payoutId: "00000000-0000-4000-8000-000000000000" });
    const { script, deps: d } = deps([{ text: "ok" }]);
    await processNextWakeup({
      ...d,
      syncCat: async () => {
        throw new Error("db blip");
      },
    });
    expect(script.requests).toHaveLength(1);
    const after = await row(wake.id);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(1);
  });

  it("an alert tells the model to ask for review and does not invite a payout", async () => {
    await enqueue("payout_status_changed", {
      payoutId: "00000000-0000-4000-8000-000000000000",
      status: "failed",
      alert: "batch_exists_after_failed",
    });
    const { script, deps: d } = deps([
      { calls: [{ name: "request_caretaker_review", input: { subject: "Late batch", reason: "PayPal saw a batch." } }] },
      { text: "Asked for a person." },
    ]);
    await processNextWakeup(d);
    const text = JSON.stringify(script.requests[0].messages);
    expect(text).toContain("request_caretaker_review");
    expect(text).toMatch(/do not (start|request|send) (a |any )?(new )?payout/i);
    // The model's own request, plus the one code files for the payout whatever the model did.
    const subjects = (await db.select().from(reviewRequests)).map((r) => r.subject).sort();
    expect(subjects).toEqual(["Late batch", "Payout 00000000-0000-4000-8000-000000000000 needs a person"]);
  });

  it("if the model ignores an alert, code still files the review", async () => {
    const wake = await enqueue("payout_status_changed", {
      payoutId: "00000000-0000-4000-8000-000000000000",
      status: "failed",
      alert: "batch_exists_after_failed",
    });
    const { gw, deps: d } = deps([{ text: "All fine, nothing to do." }]);
    await processNextWakeup(d);
    const reviews = await db.select().from(reviewRequests);
    expect(reviews).toHaveLength(1);
    expect(await db.select().from(agentActions)).toHaveLength(1);
    expect(gw.calls).toHaveLength(0);
    expect((await row(wake.id)).status).toBe("done");
  });

  it("an alert reaches a person even when the run throws, once across retries", async () => {
    const wake = await enqueue("payout_status_changed", {
      payoutId: "00000000-0000-4000-8000-000000000000",
      status: "failed",
      alert: "batch_exists_after_failed",
    });
    const { deps: d } = deps([new Error("down"), new Error("down")]);
    await processNextWakeup(d);
    expect((await row(wake.id)).status).toBe("pending");
    expect(await db.select().from(reviewRequests)).toHaveLength(1);
    await makeDue();
    await processNextWakeup(d);
    const subjects = (await db.select().from(reviewRequests)).map((r) => r.subject);
    expect(subjects).toEqual(["Payout 00000000-0000-4000-8000-000000000000 needs a person"]);
  });

  describe("a plain failed payout", () => {
    const failedEvent = (w: Awaited<ReturnType<typeof bookedCat>>, payoutId: string) => ({
      payoutId,
      bookingId: w.booking.id,
      catId: w.cat.id,
      kind: "deposit",
      status: "failed",
    });
    const fund = async (catId: string) => {
      const [d] = await db
        .insert(donations)
        .values({ gross: 150000, net: 150000, paypalOrderId: `o-${catId}`, status: "captured" })
        .returning();
      await db.insert(allocations).values({ donationId: d.id, catId, purpose: "vet", amount: 150000 });
    };

    it("a retry waits for a caretaker, so nothing is sent and no review is filed yet", async () => {
      const w = await bookedCat();
      await fund(w.cat.id);
      const first = await addPayout(w, { amount: 45000, status: "failed" });
      await enqueue("payout_status_changed", failedEvent(w, first.id));
      const gw = new FakeGateway([{ kind: "rejected", error: "HTTP 422" }]);
      const { deps: d } = deps(
        [
          { calls: [{ name: "pay_vet_deposit", input: { booking_id: w.booking.id, reason: "Trying once more." } }] },
          { text: "It failed again. Nothing more to do." },
        ],
        gw,
      );

      await processNextWakeup(d);

      // The retry is a deposit, and every deposit waits for a caretaker. The second failure, if it comes,
      // arrives with that approval and is the case in the next test.
      expect(gw.calls).toHaveLength(0);
      expect(await db.select().from(reviewRequests)).toHaveLength(0);
      expect((await db.select().from(payouts).where(eq(payouts.status, "awaiting_approval")))).toHaveLength(1);
    });

    it("files a review when two failures already stand and the model does nothing", async () => {
      const w = await bookedCat();
      await addPayout(w, { amount: 45000, status: "failed" });
      const second = await addPayout(w, { amount: 45000, status: "failed" });
      await enqueue("payout_status_changed", failedEvent(w, second.id));
      const { deps: d } = deps([{ text: "Nothing to do." }]);
      await processNextWakeup(d);
      const reviews = await db.select().from(reviewRequests);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].subject).toBe(`Payout ${second.id} needs a person`);
    });

    it("files nothing on a first failure, which the agent may still retry", async () => {
      const w = await bookedCat();
      const first = await addPayout(w, { amount: 45000, status: "failed" });
      await enqueue("payout_status_changed", failedEvent(w, first.id));
      const { deps: d } = deps([{ text: "Will look later." }]);
      await processNextWakeup(d);
      expect(await db.select().from(reviewRequests)).toHaveLength(0);
    });

    it("counts by kind, so a failed deposit does not count against the balance", async () => {
      const w = await bookedCat();
      await addPayout(w, { amount: 45000, status: "failed" });
      await addPayout(w, { amount: 45000, status: "failed" });
      const balance = await addPayout(w, { amount: 105000, status: "failed", kind: "balance" });
      await enqueue("payout_status_changed", { ...failedEvent(w, balance.id), kind: "balance" });
      const { deps: d } = deps([{ text: "ok" }]);
      await processNextWakeup(d);
      expect(await db.select().from(reviewRequests)).toHaveLength(0);
    });
  });

  it("a payout already in needs_review is treated like an alert", async () => {
    await enqueue("payout_status_changed", { payoutId: "00000000-0000-4000-8000-000000000000", status: "needs_review" });
    const { deps: d } = deps([{ text: "ok" }]);
    await processNextWakeup(d);
    expect(await db.select().from(reviewRequests)).toHaveLength(1);
  });
});

describe("maintenance", () => {
  it("runs every job, isolating a failure in any of them", async () => {
    const ran: string[] = [];
    const job = (name: string, fail = false) => async () => {
      ran.push(name);
      if (fail) throw new Error(`${name} failed`);
    };
    await runMaintenance({
      gateway: new FakeGateway(),
      reconcile: job("reconcile", true),
      retryUnknown: job("retryUnknown", true),
      retrySightings: job("sightings", true),
      develop: job("develop", true),
      recut: job("recut", true),
      retryEvidence: job("evidence"),
    });
    expect(ran).toEqual(["reconcile", "retryUnknown", "sightings", "develop", "recut", "evidence"]);
  });

  it("develops photos until the queue is empty, at most DEVELOP_PER_TICK a tick", async () => {
    const quiet = { gateway: new FakeGateway(), reconcile: async () => {}, retryUnknown: async () => {}, retrySightings: async () => {}, retryEvidence: async () => {} };
    let calls = 0;
    await runMaintenance({ ...quiet, develop: async () => (++calls, "developed" as const) });
    expect(calls).toBe(DEVELOP_PER_TICK);
    calls = 0;
    await runMaintenance({ ...quiet, develop: async () => (++calls <= 2 ? "developed" : "idle") });
    expect(calls).toBe(3);
  });
});

describe("the loops", () => {
  it("stopping lets the current wakeup finish, then both loops exit", async () => {
    const w = await enqueue();
    const stop = new AbortController();
    let inModel = false;
    const { deps: d } = deps([
      {
        text: "ok",
        before: async () => {
          inModel = true;
          stop.abort();
          await new Promise((r) => setTimeout(r, 50));
        },
      },
    ]);
    await runWorkerLoops(
      { ...d, reconcile: async () => {}, retryUnknown: async () => {}, retrySightings: async () => {}, retryEvidence: async () => {} },
      stop.signal,
      { pollMs: 5, maintenanceMs: 5 },
    );
    expect(inModel).toBe(true);
    expect((await row(w.id)).status).toBe("done");
  });

  it("a thrown tick does not kill the loop", async () => {
    const stop = new AbortController();
    let polls = 0;
    await runWorkerLoops(
      {
        ...deps([]).deps,
        reconcile: async () => {},
        retryUnknown: async () => {},
        retrySightings: async () => {},
        retryEvidence: async () => {},
        tick: async () => {
          if (++polls >= 3) stop.abort();
          throw new Error("db down");
        },
      },
      stop.signal,
      { pollMs: 1, maintenanceMs: 1000 },
    );
    expect(polls).toBeGreaterThanOrEqual(3);
  });
});

it("donations stay untouched by the worker's own bookkeeping", async () => {
  await enqueue();
  const { deps: d } = deps([{ text: "ok" }]);
  await processNextWakeup(d);
  expect(await db.select().from(donations)).toHaveLength(0);
});
