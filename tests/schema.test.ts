import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closePool } from "../src/server/db/client";
import {
  agentActions,
  bookings,
  cats,
  guardrails,
  payouts,
  users,
} from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

describe("schema", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await closePool();
  });

  it("seeds the guardrails singleton with the default values", async () => {
    const rows = await db.select().from(guardrails);
    expect(rows).toEqual([
      {
        id: 1,
        packagePrice: 150000,
        depositPct: 30,
        maxPerCat: 250000,
        maxPerDay: 1000000,
        approvalThreshold: 200000,
        earTipConfidenceMin: 0.8,
        matchConfidenceMin: 0.8,
      },
    ]);
  });

  it("refuses a second guardrails row", async () => {
    await expect(db.insert(guardrails).values({ id: 2 })).rejects.toThrow();
    await expect(db.insert(guardrails).values({ id: 1 })).rejects.toThrow();
  });

  it("allows one live payout per booking and kind, but a retry after failure", async () => {
    const [vet] = await db
      .insert(users)
      .values({ username: "vet1", role: "vet" })
      .returning();
    const [cat] = await db
      .insert(cats)
      .values({ name: "Mingming", areaName: "test" })
      .returning();
    const [booking] = await db
      .insert(bookings)
      .values({ catId: cat.id, vetId: vet.id, packagePrice: 150000, status: "booked" })
      .returning();
    const [action] = await db
      .insert(agentActions)
      .values({ action: "pay", reason: "test", status: "done" })
      .returning();
    const base = {
      catId: cat.id,
      bookingId: booking.id,
      payeeUserId: vet.id,
      amount: 45000,
      kind: "deposit",
      actionId: action.id,
    };
    await db.insert(payouts).values({ ...base, status: "failed" });
    await db.insert(payouts).values({ ...base, status: "queued" });
    await expect(
      db.insert(payouts).values({ ...base, status: "sent" }),
    ).rejects.toThrow();
  });
});
