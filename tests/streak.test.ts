import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, sightings, users } from "../src/server/db/schema";
import { COLONY } from "../src/lib/config";
import { streakLabel, streakOf, weekIndex } from "../src/lib/streak";
import { getStreakDates } from "../src/server/streak";
import { truncateAll } from "./helpers/db";

// 2026-11-02 is a Monday in Asia/Manila.
const at = (iso: string) => new Date(iso);

describe("weekIndex (Asia/Manila, Monday start)", () => {
  it("puts Monday 00:00 Manila in the new week and Sunday 23:59 in the old one", () => {
    const sundayEnd = weekIndex(at("2026-11-01T23:59:59+08:00"));
    const mondayStart = weekIndex(at("2026-11-02T00:00:00+08:00"));
    expect(mondayStart).toBe(sundayEnd + 1);
  });

  it("uses Manila time, not UTC, at the boundary", () => {
    // 16:30 UTC on Sunday is already Monday 00:30 in Manila.
    expect(weekIndex(at("2026-11-01T16:30:00Z"))).toBe(weekIndex(at("2026-11-02T09:00:00+08:00")));
    expect(weekIndex(at("2026-11-01T15:30:00Z"))).toBe(weekIndex(at("2026-11-01T09:00:00+08:00")));
  });

  it("is the same all week", () => {
    const mon = weekIndex(at("2026-11-02T08:00:00+08:00"));
    for (const d of ["03", "04", "05", "06", "07", "08"]) {
      expect(weekIndex(at(`2026-11-${d}T12:00:00+08:00`))).toBe(mon);
    }
  });
});

describe("streakOf", () => {
  const now = at("2026-11-04T10:00:00+08:00");
  it("is empty with no activity", () => {
    expect(streakOf([], now)).toEqual({ current: 0, total: 0 });
    expect(streakLabel(streakOf([], now))).toBeNull();
  });

  it("counts a week once however many sightings it has", () => {
    expect(streakOf([at("2026-11-02T09:00:00+08:00"), at("2026-11-03T09:00:00+08:00")], now)).toEqual({ current: 1, total: 1 });
  });

  it("counts consecutive weeks", () => {
    const d = ["2026-11-03", "2026-10-27", "2026-10-20"].map((x) => at(`${x}T09:00:00+08:00`));
    expect(streakOf(d, now)).toEqual({ current: 3, total: 3 });
  });

  it("does not drop the count just because this week has no sighting yet", () => {
    const d = ["2026-10-27", "2026-10-20"].map((x) => at(`${x}T09:00:00+08:00`));
    expect(streakOf(d, now)).toEqual({ current: 2, total: 2 });
  });

  it("keeps the total after a gap, with a fresh count", () => {
    const d = ["2026-11-03", "2026-09-01", "2026-08-25", "2026-08-18"].map((x) => at(`${x}T09:00:00+08:00`));
    expect(streakOf(d, now)).toEqual({ current: 1, total: 4 });
    const gap = ["2026-09-01", "2026-08-25"].map((x) => at(`${x}T09:00:00+08:00`));
    expect(streakOf(gap, now)).toEqual({ current: 0, total: 2 });
  });

  it("never lets the total go down as time passes", () => {
    const d = ["2026-08-18", "2026-08-25", "2026-09-01"].map((x) => at(`${x}T09:00:00+08:00`));
    let last = 0;
    for (const later of ["2026-09-02", "2026-09-20", "2026-12-01", "2027-06-01"]) {
      const t = streakOf(d, at(`${later}T09:00:00+08:00`)).total;
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });
});

describe("streakLabel", () => {
  it("shows only the positive", () => {
    expect(streakLabel({ current: 1, total: 1 })).toBe("1 week helping");
    expect(streakLabel({ current: 3, total: 3 })).toBe("3 weeks helping");
  });

  it("welcomes someone back with the total", () => {
    expect(streakLabel({ current: 0, total: 8 })).toBe("Welcome back. 8 weeks helping so far.");
    expect(streakLabel({ current: 1, total: 9 })).toBe("Welcome back. 9 weeks helping so far.");
  });

  it("never says lost, broken, missed or a deadline", () => {
    for (const s of [{ current: 0, total: 8 }, { current: 2, total: 2 }, { current: 1, total: 5 }]) {
      expect(streakLabel(s)).not.toMatch(/lost|broke|miss|expire|last chance|don't|day/i);
    }
  });
});

beforeEach(truncateAll);
afterAll(closePool);

describe("getStreakDates", () => {
  let n = 0;
  it("counts accepted sightings only, and never donations", async () => {
    const [u] = await db.insert(users).values({ username: `s${++n}`, role: "donor" }).returning();
    const [c] = await db.insert(cats).values({ name: "C", areaName: COLONY.area_name }).returning();
    const row = (state: string, catId: string | null = c.id) => ({
      catId,
      originalKey: `originals/${++n}.jpg`,
      caughtByUserId: u.id,
      state,
    });
    await db.insert(sightings).values([
      row("rejected"),
      row("pending", null),
      row("needs_review"),
      row("matched"),
      row("new_cat"),
    ]);
    const [d] = await db
      .insert(donations)
      .values({ userId: u.id, gross: 10000, paypalFee: 0, net: 10000, paypalOrderId: "x", status: "captured" })
      .returning();
    await db.insert(allocations).values({ donationId: d.id, catId: c.id, purpose: "vet", amount: 10000 });
    expect(await getStreakDates(u.id)).toHaveLength(2);
  });

  it("counts a needs_review sighting once a caretaker accepts it", async () => {
    const [u] = await db.insert(users).values({ username: `s${++n}`, role: "donor" }).returning();
    const [c] = await db.insert(cats).values({ name: "C", areaName: COLONY.area_name }).returning();
    const [s] = await db
      .insert(sightings)
      .values({ catId: c.id, originalKey: "originals/r.jpg", caughtByUserId: u.id, state: "needs_review" })
      .returning();
    expect(await getStreakDates(u.id)).toHaveLength(0);
    const { eq } = await import("drizzle-orm");
    await db.update(sightings).set({ state: "matched" }).where(eq(sightings.id, s.id));
    expect(await getStreakDates(u.id)).toHaveLength(1);
  });
});
