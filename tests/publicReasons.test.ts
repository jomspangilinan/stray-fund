import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, reports } from "../src/server/db/schema";
import { getLedger } from "../src/server/impact";
import { listAgentActions } from "../src/server/public";
import { truncateAll } from "./helpers/db";
import { addPayout, makeBooking, makeVet } from "./helpers/payoutFixtures";
import { eq } from "drizzle-orm";

const NOTE = "gate code 4471 behind the blue shop";

async function twoCats() {
  const [a] = await db.insert(cats).values({ name: "Mimi", areaName: "Brgy 1", status: "queued" }).returning();
  const [b] = await db.insert(cats).values({ name: "Tom", areaName: "Brgy 1", status: "queued" }).returning();
  // A note on the other cat: a reason about Mimi can still repeat it.
  await db.insert(reports).values({ catId: b.id, claim: "injured", source: "neighbour", note: NOTE, reportedOn: "2026-11-03" });
  return { a, b };
}

describe("every AI-written reason on a public page passes the filter", () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  it("a funding reason that repeats another cat's note shows a fixed line", async () => {
    const { a } = await twoCats();
    await db.insert(agentActions).values({
      action: "fund_cat",
      reason: "Mimi goes first because of the gate code 4471 behind the blue shop.",
      amount: 150000,
      status: "done",
      inputs: { catId: a.id },
    });
    const [row] = await listAgentActions();
    expect(row.reason).toBe("The Treasurer funded this cat.");
    expect(row.amount).toBe(150000);
    expect(row.status).toBe("Done");
  });

  it("a reason with a street or a phone number is replaced, whatever the action", async () => {
    const { a } = await twoCats();
    await db.insert(agentActions).values([
      { action: "fund_cat", reason: "Mimi lives at 12 Rizal Street.", amount: 1, status: "done", inputs: { catId: a.id } },
      { action: "caretaker_review", reason: "Call 0917 555 0101 about Mimi.", status: "open", inputs: {} },
      { action: "something_new", reason: "Meet at 14 Mabini Road.", status: "done", inputs: {} },
    ]);
    const reasons = (await listAgentActions()).map((r) => r.reason).sort();
    expect(reasons).toEqual(["The Treasurer asked a caretaker.", "The Treasurer funded this cat.", "The Treasurer recorded this."].sort());
  });

  it("a safe reason that names two cats is kept", async () => {
    const { a } = await twoCats();
    await db.insert(agentActions).values({
      action: "fund_cat",
      reason: "Mimi is next because Tom has waited less time.",
      status: "done",
      inputs: { catId: a.id },
    });
    expect((await listAgentActions())[0].reason).toBe("Mimi is next because Tom has waited less time.");
  });

  it("a payment's reason is filtered in the feed and the ledger, and its amount and status are untouched", async () => {
    const { a } = await twoCats();
    const vet = await makeVet();
    const booking = await makeBooking(a.id, vet.id);
    const payout = await addPayout({ cat: a, vet, booking }, { amount: 45000, status: "succeeded", kind: "deposit" });
    await db.update(agentActions).set({ action: "payout_deposit", reason: `Deposit for Mimi, ${NOTE}.` }).where(eq(agentActions.id, payout.actionId));
    const feed = (await listAgentActions()).find((r) => r.action === "Vet first payment")!;
    expect(feed.reason).toBe("The Treasurer sent the vet's first payment.");
    expect(feed).toMatchObject({ amount: null, status: "Paid" });
    const ledger = (await getLedger()).find((r) => r.type === "vet_deposit")!;
    expect(ledger.reason).toBe("The Treasurer sent the vet's first payment.");
    expect(ledger).toMatchObject({ amount: 45000, status: "succeeded" });
  });

  it("a plain payment reason stays in the ledger", async () => {
    const { a } = await twoCats();
    const vet = await makeVet();
    const booking = await makeBooking(a.id, vet.id);
    const payout = await addPayout({ cat: a, vet, booking }, { amount: 45000, status: "succeeded", kind: "balance" });
    await db.update(agentActions).set({ reason: "The receipt was checked, so the balance went out." }).where(eq(agentActions.id, payout.actionId));
    expect((await getLedger()).find((r) => r.type === "vet_balance")?.reason).toBe("The receipt was checked, so the balance went out.");
  });
});
