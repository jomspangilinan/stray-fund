import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, sightings, treatments, users } from "../src/server/db/schema";
import { COLONY } from "../src/lib/config";
import { getNews, markNewsSeen } from "../src/server/news";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);
afterAll(closePool);

let n = 0;
const mkUser = async (patch: Partial<typeof users.$inferInsert> = {}) =>
  (await db.insert(users).values({ username: `n${++n}`, role: "donor", ...patch }).returning())[0];
const mkCat = async (name: string, patch: Partial<typeof cats.$inferInsert> = {}) =>
  (await db.insert(cats).values({ name, areaName: COLONY.area_name, exactLat: 10.987654321, exactLng: 120.123456789, ...patch }).returning())[0];
async function help(userId: string, catId: string, amount = 5000, status = "captured") {
  const [d] = await db
    .insert(donations)
    .values({ userId, gross: amount, paypalFee: 0, net: amount, paypalOrderId: `o${++n}`, status })
    .returning();
  await db.insert(allocations).values({ donationId: d.id, catId, purpose: "vet", amount });
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("getNews", () => {
  it("lists treatments and new sightings for cats the person helped, newest first, dates only", async () => {
    const u = await mkUser({ createdAt: ago(30) });
    const other = await mkUser();
    const c = await mkCat("Ningning");
    await help(u.id, c.id);
    await db.insert(treatments).values({ catId: c.id, type: "neuter", date: "2026-11-01", createdAt: ago(3) });
    await db.insert(sightings).values({ catId: c.id, originalKey: "originals/a.jpg", state: "matched", caughtByUserId: other.id, createdAt: ago(1) });
    const news = await getNews(u.id);
    expect(news.items.map((i) => i.text)).toEqual(["Ningning was seen again", "Ningning was neutered"]);
    expect(news.items[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(news.items[0]).sort()).toEqual(["catId", "date", "text"]);
    expect(JSON.stringify(news)).not.toMatch(/10\.98|120\.12|originals|exact/);
  });

  it("only covers cats this person helped with a captured, net positive gift", async () => {
    const u = await mkUser({ createdAt: ago(30) });
    const mine = await mkCat("Mine");
    const pending = await mkCat("Pending");
    const nobody = await mkCat("Nobody");
    await help(u.id, mine.id);
    await help(u.id, pending.id, 5000, "pending");
    for (const c of [mine, pending, nobody]) {
      await db.insert(treatments).values({ catId: c.id, type: "vaccine", date: "2026-11-01", createdAt: ago(2) });
    }
    expect((await getNews(u.id)).items.map((i) => i.text)).toEqual(["Mine was vaccinated"]);
  });

  it("does not report the person's own sighting back to them, or rejected and pending ones", async () => {
    const u = await mkUser({ createdAt: ago(30) });
    const other = await mkUser();
    const c = await mkCat("Pepita");
    await help(u.id, c.id);
    const row = (state: string, by: string) => ({ catId: c.id, originalKey: `originals/${++n}.jpg`, state, caughtByUserId: by, createdAt: ago(1) });
    await db.insert(sightings).values([row("matched", u.id), row("rejected", other.id), row("pending", other.id), row("needs_review", other.id)]);
    expect((await getNews(u.id)).items).toEqual([]);
  });

  it("shows news at least once and clears it only after it was seen", async () => {
    const u = await mkUser({ createdAt: ago(30) });
    const c = await mkCat("Ningning");
    await help(u.id, c.id);
    await db.insert(treatments).values({ catId: c.id, type: "neuter", date: "2026-11-01", createdAt: ago(2) });
    const first = await getNews(u.id);
    const again = await getNews(u.id);
    expect(again.items).toHaveLength(1);
    expect(first.upTo).not.toBeNull();
    await markNewsSeen(u.id, first.upTo!);
    expect((await getNews(u.id)).items).toEqual([]);
    // Something new after that still shows.
    await db.insert(treatments).values({ catId: c.id, type: "deworming", date: "2026-11-02" });
    expect((await getNews(u.id)).items.map((i) => i.text)).toEqual(["Ningning was dewormed"]);
  });

  it("leaves news that arrived after the page was built", async () => {
    const u = await mkUser({ createdAt: ago(30) });
    const c = await mkCat("Ningning");
    await help(u.id, c.id);
    await db.insert(treatments).values({ catId: c.id, type: "neuter", date: "2026-11-01", createdAt: ago(2) });
    const first = await getNews(u.id);
    await db.insert(treatments).values({ catId: c.id, type: "vaccine", date: "2026-11-02" });
    await markNewsSeen(u.id, first.upTo!);
    expect((await getNews(u.id)).items.map((i) => i.text)).toEqual(["Ningning was vaccinated"]);
  });

  it("never moves the marker backward or into the future", async () => {
    const u = await mkUser({ createdAt: ago(30) });
    await markNewsSeen(u.id, new Date(Date.now() + 10 * 86_400_000).toISOString());
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.newsSeenAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const before = row.newsSeenAt!;
    await markNewsSeen(u.id, ago(20).toISOString());
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.newsSeenAt!.getTime()).toBe(before.getTime());
    await db.execute(sql`select 1`);
  });

  it("is empty for someone who helped no cat", async () => {
    const u = await mkUser();
    expect(await getNews(u.id)).toEqual({ items: [], upTo: null });
  });
});
