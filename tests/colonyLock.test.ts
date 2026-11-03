import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, closePool, withColonyLock } from "../src/server/db/client";
import { meals } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withColonyLock", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await closePool();
  });

  it("serialises concurrent critical sections", async () => {
    const events: string[] = [];
    const run = (name: string) =>
      withColonyLock(async () => {
        events.push(`${name}:start`);
        await sleep(150);
        events.push(`${name}:end`);
      });
    await Promise.all([run("a"), run("b")]);
    expect(events).toHaveLength(4);
    // Each section ends before the other starts.
    expect(events[0].endsWith(":start")).toBe(true);
    expect(events[1]).toBe(events[0].replace(":start", ":end"));
    expect(events[2].endsWith(":start")).toBe(true);
    expect(events[3]).toBe(events[2].replace(":start", ":end"));
  });

  it("rolls back writes on error and releases the lock", async () => {
    await expect(
      withColonyLock(async (tx) => {
        await tx.insert(meals).values({ source: "rolled-back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.select().from(meals).where(eq(meals.source, "rolled-back"))).toEqual([]);

    // Lock must be free: the next call completes rather than hanging.
    const result = await Promise.race([
      withColonyLock(async (tx) => {
        await tx.insert(meals).values({ source: "after" });
        return "ok";
      }),
      sleep(3000).then(() => "timeout"),
    ]);
    expect(result).toBe("ok");
    expect(await db.select().from(meals)).toHaveLength(1);
  });
});
