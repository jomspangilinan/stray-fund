import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, payouts } from "../src/server/db/schema";
import { listAgentActions, publicAgentAction } from "../src/server/public";
import { GET } from "../src/app/api/agent/feed/route";
import { AgentFeed } from "../src/components/AgentFeed";
import { truncateAll } from "./helpers/db";
import { addPayout, makeBooking, makeCaretaker, makeVet } from "./helpers/payoutFixtures";
import { feedHeadline, feedStory } from "../src/lib/feedCopy";
import { eq } from "drizzle-orm";

const SENTINELS = ["inputs-sentinel", "gateway-sentinel", "HTTP 400", "passedOver", "topPick", "approved", "bookingId"];

async function seed() {
  const caretaker = await makeCaretaker();
  const vet = await makeVet();
  const [funded] = await db.insert(cats).values({ name: "Mimi", areaName: "Brgy 1", status: "funded" }).returning();
  await db.insert(agentActions).values({
    action: "fund_cat",
    reason: "Mimi is an unspayed female.",
    amount: 150000,
    status: "done",
    approvedBy: caretaker.id,
    inputs: { catId: funded.id, secret: "inputs-sentinel", topPick: { name: "x" }, passedOver: ["y"] },
  });
  const [paid] = await db.insert(cats).values({ name: "Tom", areaName: "Brgy 1", status: "in_care" }).returning();
  const booking = await makeBooking(paid.id, vet.id);
  const payout = await addPayout({ cat: paid, vet, booking }, { amount: 45000, status: "failed" });
  await db.update(payouts).set({ lastGatewayError: "HTTP 400 gateway-sentinel" }).where(eq(payouts.id, payout.id));
  await db
    .update(agentActions)
    .set({
      action: "payout_deposit",
      reason: "Deposit for Tom.",
      amount: 45000,
      paypalRef: "BATCH123",
      inputs: { gatewayError: "gateway-sentinel" },
    })
    .where(eq(agentActions.id, payout.actionId));
  await db.insert(agentActions).values({ action: "caretaker_review", reason: "Please check.", status: "open", inputs: "not-json-object" });
  return { caretaker };
}

describe("the public agent feed", () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  it("lists actions with reason, amount, status, PayPal ref, date and cat name", async () => {
    await seed();
    const rows = await listAgentActions();
    expect(rows).toHaveLength(3);
    const fund = rows.find((r) => r.cat === "Mimi");
    expect(fund).toMatchObject({
      action: "Funded a cat",
      reason: "Mimi is an unspayed female.",
      amount: 150000,
      status: "Done",
      refused: false,
    });
    expect(fund?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows.find((r) => r.cat === "Tom")).toMatchObject({ paypalRef: "BATCH123", refused: true });
    expect(rows.find((r) => r.action === "Asked a caretaker")).toMatchObject({ cat: null, amount: null });
  });

  it("the route and the rendered feed hold no inputs, approver or error text", async () => {
    const { caretaker } = await seed();
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    const html = renderToStaticMarkup(createElement(AgentFeed, { initial: await listAgentActions() }));
    for (const out of [text, html]) {
      for (const s of [...SENTINELS, caretaker.id]) expect(out, `leaked ${s}`).not.toContain(s);
    }
    expect(html).toContain("Mimi");
    expect(html).toContain("BATCH123");
  });

  it("the mapper builds a new object field by field", () => {
    const out = publicAgentAction({
      id: "1",
      action: "something_new",
      reason: "r",
      amount: null,
      status: "brand_new_status",
      paypalRef: null,
      createdAt: new Date("2026-11-03T00:00:00Z"),
      cat: null,
      inputs: { secret: "inputs-sentinel" },
      approvedBy: "someone",
    } as never);
    expect(Object.keys(out).sort()).toEqual(
      ["action", "amount", "cat", "date", "id", "paypalRef", "reason", "refused", "signedOffByPerson", "status"].sort(),
    );
    expect(out.action).toBe("Treasurer action");
    expect(out.status).toBe("Recorded");
  });

  it("says whether a person approved an action, never who", async () => {
    const { caretaker } = await seed();
    await db.update(agentActions).set({ approvedBy: null }).where(eq(agentActions.action, "payout_deposit"));
    const rows = await listAgentActions();
    expect(rows.find((r) => r.action === "Vet first payment")?.signedOffByPerson).toBe(false);
    // Funding a cat is the AI's own choice, so a stray approver stamp on it is not a sign-off.
    expect(rows.find((r) => r.cat === "Mimi")?.signedOffByPerson).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(caretaker.id);
  });

  it("counts a sign-off only on a payment a caretaker approved and the rules let through", () => {
    const base = { id: "1", reason: "r", amount: 1, paypalRef: null, createdAt: new Date(), cat: "Luna" };
    const shown = (action: string, status: string, signedOffByPerson: boolean) => publicAgentAction({ ...base, action, status, signedOffByPerson }).signedOffByPerson;
    expect(shown("payout_deposit", "succeeded", true)).toBe(true);
    expect(shown("payout_balance", "queued", true)).toBe(true);
    // Under the threshold nobody approved it.
    expect(shown("payout_deposit", "succeeded", false)).toBe(false);
    // A refusal or rejection stamps a caretaker on the row but approved nothing.
    expect(shown("payout_deposit", "rejected", true)).toBe(false);
    expect(shown("payout_deposit", "denied", true)).toBe(false);
    // Waiting, notes, reviews and funding are not approvals of a payout.
    expect(shown("payout_deposit", "awaiting_approval", true)).toBe(false);
    expect(shown("payout_note", "done", true)).toBe(false);
    expect(shown("caretaker_review", "resolved", true)).toBe(false);
    expect(shown("fund_cat", "done", true)).toBe(false);
    // Absent reads as false.
    expect(publicAgentAction({ ...base, action: "payout_deposit", status: "succeeded" } as never).signedOffByPerson).toBe(false);
  });

  it("the feed story names a person only when one signed off", () => {
    const pay = (status: string, signedOffByPerson: boolean) => feedStory({ action: "Vet first payment", status, signedOffByPerson });
    expect(pay("Paid", true)?.person).toBe("A caretaker signed it off.");
    expect(pay("Paid", false)?.person).toBe("No caretaker signed it off.");
    expect(pay("Waiting for approval", false)?.person).toBe("Waiting for a caretaker to sign it off.");
    expect(pay("Refused by the rules", false)?.person).toBe("The spending rules stopped it.");
    expect(pay("Rejected", false)?.person).toBe("It was stopped and nothing was paid.");
    expect(pay("Rejected", false)?.person).not.toMatch(/rules|signed/);
  });
  it("a payment being checked says so, and never claims it was sent or needed no sign-off", () => {
    const checking = { action: "Vet first payment", status: "Being checked", signedOffByPerson: false };
    expect(feedHeadline({ ...checking, cat: "Mimi" })).toBe("Checking the first payment for Mimi");
    expect(feedStory(checking)).toEqual({ ai: "The AI treasurer proposed it.", person: "A caretaker needs to check this." });
    expect(JSON.stringify(feedStory(checking))).not.toMatch(/No sign-off|within the spending rules/);
  });

  it("a payment sent to PayPal says it is waiting on PayPal", () => {
    expect(feedHeadline({ action: "Vet final payment", status: "Sent", cat: "Tom" })).toBe("Sent the final payment for Tom, waiting for PayPal");
  });

  it("a late SUCCESS a caretaker ruled Paid never says no sign-off was needed", () => {
    const paid = feedStory({ action: "Vet final payment", status: "Paid", signedOffByPerson: false });
    expect(paid?.person).toBe("No caretaker signed it off.");
    expect(paid?.person).not.toMatch(/needed|within the spending rules/);
    expect(feedHeadline({ action: "Vet final payment", status: "Paid", cat: "Tom" })).toBe("Paid the final payment for Tom");
  });

  it("an empty feed says so", () => {
    expect(renderToStaticMarkup(createElement(AgentFeed, { initial: [] }))).toContain("Nothing yet");
  });
});
