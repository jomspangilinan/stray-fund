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
      ["action", "amount", "cat", "date", "id", "paypalRef", "reason", "refused", "status"].sort(),
    );
    expect(out.action).toBe("Treasurer action");
    expect(out.status).toBe("Recorded");
  });

  it("an empty feed says so", () => {
    expect(renderToStaticMarkup(createElement(AgentFeed, { initial: [] }))).toContain("Nothing yet");
  });
});
