import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { cats } from "../src/server/db/schema";
import { backfillAvatars } from "../src/server/avatars";
import { runMaintenance } from "../src/server/agent/worker";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);
afterAll(closePool);

describe("avatar backfill", () => {
  it("fills cats that have none, leaves ready ones alone, and is safe to run twice", async () => {
    const ready = { pattern: "solid", base: "grey", accent: "cream" };
    const [a, b, c] = await db
      .insert(cats)
      .values([
        { name: "A", areaName: "x", coat: { colors: ["orange"], markings: "" }, coatPattern: "tabby" },
        { name: "B", areaName: "x", avatar: ready, coat: { colors: ["black"] }, coatPattern: "tuxedo" },
        { name: "C", areaName: "x" },
      ])
      .returning();
    expect(await backfillAvatars()).toBe(2);
    expect(await backfillAvatars()).toBe(0);
    const row = async (id: string) => (await db.select({ avatar: cats.avatar }).from(cats).where(eq(cats.id, id)))[0].avatar;
    expect(await row(a.id)).toEqual({ pattern: "tabby", base: "ginger", accent: "brown" });
    expect(await row(b.id)).toEqual(ready);
    expect(await row(c.id)).toEqual({ pattern: "unknown", base: "grey", accent: "cream" });
  });

  it("runs as one isolated maintenance job", async () => {
    const ran: string[] = [];
    await runMaintenance({
      reconcile: async () => ran.push("reconcile"),
      retryUnknown: async () => ran.push("retryUnknown"),
      retrySightings: async () => ran.push("sightings"),
      retryEvidence: async () => ran.push("evidence"),
      backfillAvatars: async () => {
        ran.push("avatars");
        throw new Error("boom");
      },
    });
    expect(ran).toContain("avatars");
    expect(ran).toHaveLength(5);
  });
});
