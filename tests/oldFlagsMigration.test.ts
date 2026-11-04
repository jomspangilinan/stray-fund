import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { cats, reports, users } from "../src/server/db/schema";
import { heldCatIds } from "../src/server/reports";
import { truncateAll } from "./helpers/db";

const SQL = readFileSync("drizzle/0027_old_flags_to_reports.sql", "utf8");
const run = async () => {
  for (const statement of SQL.split("--> statement-breakpoint")) if (statement.trim()) await db.execute(statement as never);
};

beforeEach(truncateAll);
afterAll(closePool);

async function oldCat(name: string, flags: string[], status = "queued") {
  const [c] = await db.insert(cats).values({ name, areaName: "Brgy 1", status, flags }).returning();
  return c;
}

describe("0027: flags that came before reports become reports a person checks", () => {
  it("files an open photo report with no reporter for each hurt, pregnant or sick flag, and removes the flag", async () => {
    const hurt = await oldCat("Hurt", ["injured", "kitten"]);
    const two = await oldCat("Two", ["pregnant", "sick"]);
    const plain = await oldCat("Plain", ["kitten"]);
    await run();

    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ source: "photo", status: "open", reporterId: null, sightingId: null, note: null, sample: false, decidedBy: null });
    }
    expect(rows.filter((r) => r.catId === hurt.id).map((r) => r.claim)).toEqual(["injured"]);
    expect(rows.filter((r) => r.catId === two.id).map((r) => r.claim).sort()).toEqual(["pregnant", "sick"]);
    expect(rows.some((r) => r.catId === plain.id)).toBe(false);

    const flags = Object.fromEntries((await db.select().from(cats)).map((c) => [c.name, c.flags]));
    expect(flags).toEqual({ Hurt: ["kitten"], Two: [], Plain: ["kitten"] });
    expect(await heldCatIds(db)).toEqual(new Set([hurt.id, two.id]));
  });

  it("leaves a flag alone when a report for that claim already exists, and a neutered cat's history", async () => {
    const [person] = await db.insert(users).values({ username: "care", role: "caretaker" }).returning();
    const set = await oldCat("Set", ["injured", "sick"]);
    await db.insert(reports).values({ catId: set.id, claim: "injured", source: "caretaker", reporterId: person.id, status: "cleared", reportedOn: "2026-11-01" });
    const done = await oldCat("Done", ["pregnant"], "neutered");
    await run();

    const rows = await db.select().from(reports).where(eq(reports.catId, set.id));
    expect(rows.map((r) => `${r.claim}:${r.status}`).sort()).toEqual(["injured:cleared", "sick:open"]);
    expect((await db.select().from(cats).where(eq(cats.id, set.id)))[0].flags).toEqual(["injured"]);
    expect(await db.select().from(reports).where(eq(reports.catId, done.id))).toHaveLength(0);
    expect((await db.select().from(cats).where(eq(cats.id, done.id)))[0].flags).toEqual(["pregnant"]);
  });

  it("is a no-op the second time", async () => {
    await oldCat("Hurt", ["injured"]);
    await run();
    await run();
    expect(await db.select().from(reports)).toHaveLength(1);
  });
});
