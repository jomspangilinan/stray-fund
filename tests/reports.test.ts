import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, reports, sightings, users, wakeups } from "../src/server/db/schema";
import {
  REPORT_WAKEUP,
  attachReports,
  clearCatForSurgery,
  filePhotoReports,
  confirmReport,
  dismissReport,
  fileReport,
  fileStaffReport,
  heldCatIds,
} from "../src/server/reports";
import { PRIVATE_ACTIONS } from "../src/server/privateActions";
import { listAgentActions } from "../src/server/public";
import { truncateAll } from "./helpers/db";
import { makeCaretaker, makeVet } from "./helpers/payoutFixtures";

let seq = 0;
async function makeUser() {
  const [u] = await db.insert(users).values({ username: `neighbour_${Date.now()}_${++seq}`, role: "donor" }).returning();
  return u;
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db
    .insert(cats)
    .values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "spotted", ...over })
    .returning();
  return c;
}
async function makeSighting(over: Partial<typeof sightings.$inferInsert> = {}) {
  const [s] = await db
    .insert(sightings)
    .values({ originalKey: `k${++seq}`, state: "matched", ...over })
    .returning();
  return s;
}
const catRow = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0];
const reportRow = async (id: string) => (await db.select().from(reports).where(eq(reports.id, id)))[0];
const held = () => db.transaction((tx) => heldCatIds(tx));
const wakeKinds = async () => (await db.select().from(wakeups)).map((w) => w.kind);

async function file(over: Partial<Parameters<typeof fileReport>[1]> & { catId: string | null }) {
  const sighting = over.sightingId ? { id: over.sightingId } : await makeSighting({ catId: over.catId, caughtByUserId: over.reporterId ?? null });
  return db.transaction((tx) =>
    fileReport(tx, {
      sightingId: sighting.id,
      claim: "injured",
      note: null,
      source: "neighbour",
      reporterId: null,
      ...over,
    }),
  );
}

beforeEach(truncateAll);
afterAll(closePool);

describe("the hold", () => {
  it("an open injured report holds the cat, and an open kitten report does not", async () => {
    const cat = await makeCat();
    const other = await makeCat();
    await file({ catId: cat.id, claim: "injured" });
    await file({ catId: other.id, claim: "kitten" });
    expect(await held()).toEqual(new Set([cat.id]));
  });

  it("pregnant and sick hold the cat too", async () => {
    const [a, b] = [await makeCat(), await makeCat()];
    await file({ catId: a.id, claim: "pregnant" });
    await file({ catId: b.id, claim: "sick" });
    expect(await held()).toEqual(new Set([a.id, b.id]));
  });

  it("a neighbour's report does not change cats.flags, and confirming adds the flag", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const { id } = await file({ catId: cat.id, claim: "injured" });
    expect((await catRow(cat.id)).flags).toEqual([]);
    expect(await db.transaction((tx) => confirmReport(tx, id, care.id))).toEqual({ ok: true });
    expect((await catRow(cat.id)).flags).toEqual(["injured"]);
    expect((await reportRow(id)).status).toBe("confirmed");
    expect((await reportRow(id)).decidedBy).toBe(care.id);
    // Still held: a confirmed report keeps the cat until a vet clears it.
    expect(await held()).toEqual(new Set([cat.id]));
  });

  it("confirming does not duplicate a flag the cat already has", async () => {
    const cat = await makeCat({ flags: ["injured"] });
    const care = await makeCaretaker();
    const { id } = await file({ catId: cat.id, claim: "injured" });
    await db.transaction((tx) => confirmReport(tx, id, care.id));
    expect((await catRow(cat.id)).flags).toEqual(["injured"]);
  });

  it("dismissing removes the hold and leaves the flags alone", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const { id } = await file({ catId: cat.id });
    expect(await db.transaction((tx) => dismissReport(tx, id, care.id))).toEqual({ ok: true });
    expect(await held()).toEqual(new Set());
    expect((await reportRow(id)).status).toBe("dismissed");
    expect((await catRow(cat.id)).flags).toEqual([]);
  });

  it("a vet clearing the cat removes the hold from confirmed reports and keeps the flag", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const vet = await makeVet();
    const { id } = await file({ catId: cat.id });
    await db.transaction((tx) => confirmReport(tx, id, care.id));
    await db.transaction((tx) => clearCatForSurgery(tx, cat.id, vet.id));
    expect(await held()).toEqual(new Set());
    const row = await reportRow(id);
    expect(row.status).toBe("cleared");
    expect(row.decidedBy).toBe(vet.id);
    expect((await catRow(cat.id)).flags).toEqual(["injured"]);
  });

  it("a vet clearing the cat does not clear an open report", async () => {
    const cat = await makeCat();
    const vet = await makeVet();
    const { id } = await file({ catId: cat.id });
    await db.transaction((tx) => clearCatForSurgery(tx, cat.id, vet.id));
    expect((await reportRow(id)).status).toBe("open");
    expect(await held()).toEqual(new Set([cat.id]));
  });

  it("a caretaker's or vet's own report is confirmed at once, holds the cat and sets the flag", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const { id } = await db.transaction((tx) => fileStaffReport(tx, { catId: cat.id, claim: "sick", source: "caretaker", reporterId: care.id }));
    const row = await reportRow(id);
    expect(row.status).toBe("confirmed");
    expect(row.sightingId).toBeNull();
    expect((await catRow(cat.id)).flags).toEqual(["sick"]);
    expect(await held()).toEqual(new Set([cat.id]));
  });

  it("filing the same staff report twice on one day is safe", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const input = { catId: cat.id, claim: "sick" as const, source: "caretaker" as const, reporterId: care.id };
    const a = await db.transaction((tx) => fileStaffReport(tx, input));
    const b = await db.transaction((tx) => fileStaffReport(tx, input));
    expect(b.id).toBe(a.id);
    expect(await db.select().from(reports)).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("confirming or dismissing a report that is not open refuses and changes nothing", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const { id } = await file({ catId: cat.id });
    await db.transaction((tx) => confirmReport(tx, id, care.id));
    const before = await reportRow(id);
    const actionsBefore = (await db.select().from(agentActions)).length;
    const wakesBefore = (await db.select().from(wakeups)).length;
    expect(await db.transaction((tx) => confirmReport(tx, id, care.id))).toMatchObject({ ok: false, reason: "not_open" });
    expect(await db.transaction((tx) => dismissReport(tx, id, care.id))).toMatchObject({ ok: false, reason: "not_open" });
    expect(await reportRow(id)).toEqual(before);
    expect((await db.select().from(agentActions)).length).toBe(actionsBefore);
    expect((await db.select().from(wakeups)).length).toBe(wakesBefore);
    expect(await db.transaction((tx) => confirmReport(tx, "00000000-0000-4000-8000-000000000000", care.id))).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("the same reporter, claim and cat on one Manila day is refused", async () => {
    const cat = await makeCat();
    const me = await makeUser();
    await file({ catId: cat.id, reporterId: me.id });
    await expect(file({ catId: cat.id, reporterId: me.id })).rejects.toMatchObject({ reason: "already_today" });
    // A different claim, a different cat and a different person are all fine.
    await file({ catId: cat.id, reporterId: me.id, claim: "sick" });
    await file({ catId: (await makeCat()).id, reporterId: me.id });
    await file({ catId: cat.id, reporterId: (await makeUser()).id });
    expect(await db.select().from(reports)).toHaveLength(4);
  });

  it("the Manila day, not the UTC day, sets reported_on", async () => {
    const cat = await makeCat();
    const { id } = await file({ catId: cat.id });
    const { rows } = await db.execute(
      (await import("drizzle-orm")).sql`select (reported_on = (now() at time zone 'Asia/Manila')::date) as ok from reports where id = ${id}`,
    );
    expect((rows[0] as { ok: boolean }).ok).toBe(true);
  });

  it("a reporter whose claim on that cat was dismissed cannot file it again", async () => {
    const cat = await makeCat();
    const me = await makeUser();
    const care = await makeCaretaker();
    const { id } = await file({ catId: cat.id, reporterId: me.id });
    await db.transaction((tx) => dismissReport(tx, id, care.id));
    // Even on another day: move the dismissed report back a day to prove the rule is not the daily one.
    await db.update(reports).set({ reportedOn: "2020-01-01" }).where(eq(reports.id, id));
    await expect(file({ catId: cat.id, reporterId: me.id })).rejects.toMatchObject({ reason: "dismissed_before" });
    // Another claim on the same cat is allowed.
    await file({ catId: cat.id, reporterId: me.id, claim: "sick" });
  });

  it("a neighbour report with no sightingId is a type error and a runtime refusal", async () => {
    const cat = await makeCat();
    const bad = {
      catId: cat.id,
      claim: "injured" as const,
      note: null,
      source: "neighbour" as const,
      reporterId: null,
    };
    await expect(
      db.transaction((tx) =>
        // @ts-expect-error sightingId is required
        fileReport(tx, bad),
      ),
    ).rejects.toMatchObject({ reason: "sighting_required" });
    await expect(
      db.transaction((tx) =>
        // @ts-expect-error sightingId may not be null
        fileReport(tx, { ...bad, sightingId: null }),
      ),
    ).rejects.toMatchObject({ reason: "sighting_required" });
    await expect(
      db.transaction((tx) => fileReport(tx, { ...bad, sightingId: "00000000-0000-4000-8000-000000000000" })),
    ).rejects.toMatchObject({ reason: "sighting_required" });
    expect(await db.select().from(reports)).toHaveLength(0);
  });
});

describe("a report with no cat yet", () => {
  it("attaches through attachReports and then holds the cat", async () => {
    const cat = await makeCat();
    const s = await makeSighting({ state: "needs_review" });
    const { id } = await file({ catId: null, sightingId: s.id });
    expect(await held()).toEqual(new Set());
    await db.transaction((tx) => attachReports(tx, s.id, cat.id));
    expect((await reportRow(id)).catId).toBe(cat.id);
    expect(await held()).toEqual(new Set([cat.id]));
  });

  it("leaves a report that already has a cat, and other sightings, alone", async () => {
    const [a, b] = [await makeCat(), await makeCat()];
    const s = await makeSighting();
    const other = await makeSighting({ state: "needs_review" });
    await db.update(sightings).set({ catId: a.id }).where(eq(sightings.id, s.id));
    const withCat = await file({ catId: a.id, sightingId: s.id });
    const unrelated = await file({ catId: null, sightingId: other.id });
    await db.transaction((tx) => attachReports(tx, s.id, b.id));
    expect((await reportRow(withCat.id)).catId).toBe(a.id);
    expect((await reportRow(unrelated.id)).catId).toBeNull();
  });

  it("cannot be confirmed before it has a cat", async () => {
    const care = await makeCaretaker();
    const { id } = await file({ catId: null });
    expect(await db.transaction((tx) => confirmReport(tx, id, care.id))).toMatchObject({ ok: false, reason: "no_cat" });
    expect((await reportRow(id)).status).toBe("open");
  });
});

describe("photo_agrees", () => {
  const assessment = (injured: boolean) => ({ is_cat: true, flags: { injured, pregnant: false, sick: false, kitten: false } });

  it("is true when the sighting's assessment has that flag", async () => {
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id, assessment: assessment(true) });
    const { id } = await file({ catId: cat.id, sightingId: s.id });
    expect((await reportRow(id)).photoAgrees).toBe(true);
  });

  it("is false when the assessment does not have it", async () => {
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id, assessment: assessment(false) });
    const { id } = await file({ catId: cat.id, sightingId: s.id });
    expect((await reportRow(id)).photoAgrees).toBe(false);
  });

  it("is null with no assessment", async () => {
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id, assessment: null });
    const { id } = await file({ catId: cat.id, sightingId: s.id });
    expect((await reportRow(id)).photoAgrees).toBeNull();
  });
});

describe("waking the treasurer", () => {
  const catIds = async () => (await db.select().from(wakeups)).map((w) => (w.payload as { catId: string }).catId);

  it("fileReport, confirmReport and dismissReport each enqueue one report_changed with the cat", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const a = await file({ catId: cat.id });
    expect(await wakeKinds()).toEqual([REPORT_WAKEUP]);
    expect(await catIds()).toEqual([cat.id]);
    // A confirm and a dismiss always wake it, whatever is pending.
    await db.transaction((tx) => confirmReport(tx, a.id, care.id));
    expect(await wakeKinds()).toEqual([REPORT_WAKEUP, REPORT_WAKEUP]);
    const b = await file({ catId: cat.id, claim: "sick" });
    await db.transaction((tx) => dismissReport(tx, b.id, care.id));
    expect((await wakeKinds()).filter((k) => k === REPORT_WAKEUP)).toHaveLength(3);
    expect(REPORT_WAKEUP).toBe("report_changed");
  });

  it("fileReport enqueues none if one is pending for that cat from the last 15 minutes", async () => {
    const cat = await makeCat();
    await file({ catId: cat.id });
    await file({ catId: cat.id, claim: "sick" });
    expect(await wakeKinds()).toHaveLength(1);
    // Another cat still wakes it.
    await file({ catId: (await makeCat()).id });
    expect(await wakeKinds()).toHaveLength(2);
  });

  it("fileReport wakes again once the last wakeup is older than 15 minutes", async () => {
    const cat = await makeCat();
    await file({ catId: cat.id });
    await db.update(wakeups).set({ createdAt: new Date(Date.now() - 16 * 60_000) });
    await file({ catId: cat.id, claim: "sick" });
    expect(await wakeKinds()).toHaveLength(2);
  });

  it("fileReport counts a wakeup the worker already took: at most one per cat per 15 minutes, whatever its status", async () => {
    const cat = await makeCat();
    await file({ catId: cat.id });
    await db.update(wakeups).set({ status: "done" });
    await file({ catId: cat.id, claim: "sick" });
    expect(await wakeKinds()).toHaveLength(1);
  });

  it("a report with no cat yet wakes nothing", async () => {
    await file({ catId: null });
    expect(await wakeKinds()).toEqual([]);
  });
});

describe("the audit trail", () => {
  it("leaves a private row for each decision, with no note text", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const vet = await makeVet();
    const { id } = await file({ catId: cat.id, note: "call 0917 123 4567 at Rizal St" });
    await db.transaction((tx) => confirmReport(tx, id, care.id));
    await db.transaction((tx) => clearCatForSurgery(tx, cat.id, vet.id));
    const rows = await db.select().from(agentActions);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["report_filed", "report_confirmed", "report_cleared"]));
    for (const r of rows) expect(PRIVATE_ACTIONS).toContain(r.action);
    expect(JSON.stringify(rows)).not.toMatch(/0917|Rizal/);
  });

  it("never reaches the public feed", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    const { id } = await file({ catId: cat.id });
    await db.transaction((tx) => confirmReport(tx, id, care.id));
    expect(await db.select().from(agentActions)).not.toHaveLength(0);
    expect(await listAgentActions()).toEqual([]);
  });
});

describe("one gate for attaching (I1, I2, I5)", () => {
  it("a second cat-less report of the same claim on one photo is refused, so settling attaches the one", async () => {
    const cat = await makeCat();
    const me = await makeUser();
    const s = await makeSighting({ state: "needs_review", caughtByUserId: me.id });
    const a = await file({ catId: null, sightingId: s.id, reporterId: me.id });
    await expect(file({ catId: null, sightingId: s.id, reporterId: me.id })).rejects.toMatchObject({ reason: "already_today" });
    expect(await db.transaction((tx) => attachReports(tx, s.id, cat.id))).toBe(1);
    expect(await reportRow(a.id)).toMatchObject({ status: "open", catId: cat.id });
  });

  it("a reporter whose claim on the cat was dismissed gets a cat-less repeat closed, not attached", async () => {
    const cat = await makeCat();
    const me = await makeUser();
    const care = await makeCaretaker();
    const first = await file({ catId: cat.id, reporterId: me.id });
    await db.transaction((tx) => dismissReport(tx, first.id, care.id));
    await db.update(reports).set({ reportedOn: "2020-01-01" }).where(eq(reports.id, first.id));
    const s = await makeSighting({ state: "needs_review", caughtByUserId: me.id });
    const again = await file({ catId: null, sightingId: s.id, reporterId: me.id });
    expect(await db.transaction((tx) => attachReports(tx, s.id, cat.id))).toBe(0);
    expect(await reportRow(again.id)).toMatchObject({ status: "dismissed", catId: null });
    expect(await held()).toEqual(new Set());
  });

  it("closes a report whose claim the cat already has confirmed, or already has open, whatever the source", async () => {
    const [flagged, busy] = [await makeCat({ flags: ["injured"] }), await makeCat()];
    await file({ catId: busy.id });
    const s1 = await makeSighting({ state: "needs_review" });
    const s2 = await makeSighting({ state: "needs_review" });
    const r1 = await file({ catId: null, sightingId: s1.id, source: "photo" });
    const r2 = await file({ catId: null, sightingId: s2.id, source: "neighbour" });
    await db.transaction((tx) => attachReports(tx, s1.id, flagged.id));
    await db.transaction((tx) => attachReports(tx, s2.id, busy.id));
    expect(await reportRow(r1.id)).toMatchObject({ status: "dismissed", catId: null });
    expect(await reportRow(r2.id)).toMatchObject({ status: "dismissed", catId: null });
  });
});

describe("a report is tied to its photo (I3)", () => {
  it("refuses a cat that is not the sighting's cat, and a cat on a sighting with none", async () => {
    const [a, b] = [await makeCat(), await makeCat()];
    const matched = await makeSighting({ catId: a.id });
    const open = await makeSighting({ state: "needs_review" });
    await expect(file({ catId: b.id, sightingId: matched.id })).rejects.toMatchObject({ reason: "sighting_mismatch" });
    await expect(file({ catId: b.id, sightingId: open.id })).rejects.toMatchObject({ reason: "sighting_mismatch" });
    await expect(file({ catId: null, sightingId: matched.id })).rejects.toMatchObject({ reason: "sighting_mismatch" });
    await file({ catId: a.id, sightingId: matched.id });
    await file({ catId: null, sightingId: open.id });
  });

  it("refuses a neighbour's report on a photo someone else took", async () => {
    const cat = await makeCat();
    const [me, other] = [await makeUser(), await makeUser()];
    const s = await makeSighting({ catId: cat.id, caughtByUserId: other.id });
    await expect(file({ catId: cat.id, sightingId: s.id, reporterId: me.id })).rejects.toMatchObject({ reason: "not_your_photo" });
    await file({ catId: cat.id, sightingId: s.id, reporterId: other.id });
    // A photo claim has no signed-in reporter and is not held to this.
    await file({ catId: cat.id, sightingId: s.id, source: "photo", claim: "sick" });
  });
});

describe("photo claims after a decision (I4)", () => {
  const photo = async (cat: { id: string }, claim: "injured" | "sick" = "injured") => {
    const s = await makeSighting({ catId: cat.id });
    await db.transaction((tx) => filePhotoReports(tx, s.id, cat.id, [claim]));
  };

  it("skips a claim dismissed on that cat in the last 30 days, and files it again after that", async () => {
    const cat = await makeCat();
    const care = await makeCaretaker();
    await photo(cat);
    const [r] = await db.select().from(reports);
    await db.transaction((tx) => dismissReport(tx, r.id, care.id));
    await photo(cat);
    expect(await db.select().from(reports)).toHaveLength(1);
    await db.update(reports).set({ decidedAt: new Date(Date.now() - 31 * 86_400_000) });
    await photo(cat);
    expect(await db.select().from(reports)).toHaveLength(2);
  });

  it("skips a claim the cat was vet-cleared of in the last 30 days", async () => {
    const cat = await makeCat();
    const [care, vet] = [await makeCaretaker(), await makeVet()];
    await photo(cat);
    const [r] = await db.select().from(reports);
    await db.transaction((tx) => confirmReport(tx, r.id, care.id));
    await db.update(cats).set({ flags: [] }).where(eq(cats.id, cat.id));
    await db.transaction((tx) => clearCatForSurgery(tx, cat.id, vet.id));
    await photo(cat);
    expect(await db.select().from(reports)).toHaveLength(1);
  });

  it("leaves photo_agrees null on a photo report", async () => {
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id, assessment: { flags: { injured: true } } });
    await db.transaction((tx) => filePhotoReports(tx, s.id, cat.id, ["injured"]));
    expect((await db.select().from(reports))[0].photoAgrees).toBeNull();
  });
});

describe("staff reports on a conflict (M3)", () => {
  it("makes the flag and the hold true again after set, clear, unset, reset on one day", async () => {
    const cat = await makeCat();
    const [care, vet] = [await makeCaretaker(), await makeVet()];
    const input = { catId: cat.id, claim: "sick" as const, source: "caretaker" as const, reporterId: care.id };
    await db.transaction((tx) => fileStaffReport(tx, input));
    await db.transaction((tx) => clearCatForSurgery(tx, cat.id, vet.id));
    await db.update(cats).set({ flags: [] }).where(eq(cats.id, cat.id));
    await db.transaction((tx) => fileStaffReport(tx, input));
    expect((await catRow(cat.id)).flags).toEqual(["sick"]);
    expect(await held()).toEqual(new Set([cat.id]));
    expect(await db.select().from(reports)).toHaveLength(1);
  });
});
