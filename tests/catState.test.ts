import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { canTransition, CAT_STATUSES, type CatStatus } from "../src/lib/catState";
import { IllegalTransition, transitionCat } from "../src/server/catTransitions";
import { cats } from "../src/server/db/schema";
import { db } from "../src/server/db/client";
import { closePool } from "../src/server/db/client";
import { eq } from "drizzle-orm";
import { truncateAll } from "./helpers/db";

const arrows: [CatStatus, CatStatus][] = [
  ["spotted", "queued"],
  ["queued", "funded"],
  ["funded", "booked"],
  ["booked", "in_care"],
  ["in_care", "neutered"],
  ["neutered", "adoptable"],
  ["adoptable", "adopted"],
  ["spotted", "neutered"],
  ["queued", "neutered"],
  ["neutered", "queued"],
  ["adoptable", "neutered"],
  ["adopted", "adoptable"],
];

describe("canTransition", () => {
  it("allows exactly the spec arrows", () => {
    for (const a of CAT_STATUSES) {
      for (const b of CAT_STATUSES) {
        const expected = arrows.some(([x, y]) => x === a && y === b);
        expect(canTransition(a, b), `${a}->${b}`).toBe(expected);
      }
    }
  });

  it("rejects the named bad moves", () => {
    expect(canTransition("spotted", "in_care")).toBe(false);
    expect(canTransition("adopted", "spotted")).toBe(false);
  });
});

describe("transitionCat", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await closePool();
  });

  async function makeCat(status: string) {
    const [row] = await db
      .insert(cats)
      .values({ name: "Mingming", status, areaName: "test" })
      .returning();
    return row.id;
  }

  it("updates the row on a legal move", async () => {
    const id = await makeCat("spotted");
    await db.transaction((tx) => transitionCat(tx, id, "queued"));
    const [row] = await db.select().from(cats).where(eq(cats.id, id));
    expect(row.status).toBe("queued");
  });

  it("throws IllegalTransition and leaves the row unchanged", async () => {
    const id = await makeCat("spotted");
    await expect(
      db.transaction((tx) => transitionCat(tx, id, "in_care")),
    ).rejects.toBeInstanceOf(IllegalTransition);
    const [row] = await db.select().from(cats).where(eq(cats.id, id));
    expect(row.status).toBe("spotted");
  });

  it("throws for a cat that does not exist", async () => {
    await expect(
      db.transaction((tx) =>
        transitionCat(tx, "00000000-0000-0000-0000-000000000000", "queued"),
      ),
    ).rejects.toThrow(/not found/i);
  });
});
