import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { allocations, cats, donations, reports, sightings, users } from "../src/server/db/schema";
import { runAgent } from "../src/server/agent/run";
import { clearCatForSurgery, confirmReport, dismissReport, fileReport, REPORT_WAKEUP } from "../src/server/reports";
import { getPriorityList } from "../src/server/public";
import { catTimeline } from "../src/server/timeline";
import { truncateAll } from "./helpers/db";
import { FakeGateway, makeCaretaker, makeVet } from "./helpers/payoutFixtures";
import { scriptedClient, type ScriptedCall } from "./helpers/scriptedClient";

/*
 * The whole report story on fakes: no PayPal, no model. A scripted client plays the Treasurer through the real tool
 * runner and the real tools, and the real database holds everything else. At each stage the priority list and the
 * cat's timeline are read the way a neighbour reads them.
 */

const NOW = new Date("2026-11-03T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const PACKAGE = 150_000;

async function cat(name: string, over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name, areaName: "Brgy 1", status: "queued", ...over }).returning();
  return c;
}

/** The Treasurer wakes, makes these calls one per turn, and says it is done. Returns each tool's answer. */
async function treasurer(calls: ScriptedCall[]) {
  const script = scriptedClient([...calls.map((c) => ({ calls: [c] })), { text: "Done." }]);
  const res = await runAgent(
    { kind: REPORT_WAKEUP, payload: {} },
    { client: script.client, gateway: new FakeGateway(), now: () => NOW, loadToolkit: async () => [], consumeBudget: async () => true },
  );
  expect(res.stop).toBe("end_turn");
  return script.toolResults().map((r) => ({ isError: r.isError, body: JSON.parse(r.content) as Record<string, unknown> }));
}

const listed = async () => {
  const list = await getPriorityList(NOW);
  return {
    needs: list.needsPerson.map((r) => r.name),
    next: list.nextToFund.map((r) => r.name),
    row: (name: string) => [...list.needsPerson, ...list.nextToFund].find((r) => r.name === name),
  };
};
const timelineOf = async (id: string) => (await catTimeline(id)).filter((e) => e.done).map((e) => e.title);

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(closePool);

async function world() {
  const mimi = await cat("Mimi", { sex: "female", queuedAt: daysAgo(14) });
  const tom = await cat("Tom", { sex: "male", queuedAt: daysAgo(6) });
  const [neighbour] = await db.insert(users).values({ username: "finder_story", role: "donor" }).returning();
  const [photo] = await db.insert(sightings).values({ catId: tom.id, originalKey: "k-story", state: "matched", caughtByUserId: neighbour.id }).returning();
  const [caretaker, vet] = [await makeCaretaker(), await makeVet()];
  await db.insert(donations).values({ gross: PACKAGE, net: PACKAGE, paypalOrderId: "o-story", status: "captured" });
  const report = await db.transaction((tx) =>
    fileReport(tx, { sightingId: photo.id, catId: tom.id, claim: "injured", note: "limping badly near the old gate", source: "neighbour", reporterId: neighbour.id }),
  );
  return { mimi, tom, caretaker, vet, report };
}

describe("a hurt report from the first photo to the funded cat", () => {
  it("holds, asks, confirms, clears, moves citing the report, funds, and the list and timeline tell it at each stage", async () => {
    const { mimi, tom, caretaker, vet, report } = await world();

    // 1. Open: Tom is held and listed as waiting for a person. Mimi is the next to fund.
    let l = await listed();
    expect(l.needs).toEqual(["Tom"]);
    expect(l.next).toEqual(["Mimi"]);
    expect(l.row("Tom")).toMatchObject({ labels: ["Neighbour says hurt"], reason: "A person needs to check this first." });
    expect(await timelineOf(tom.id)).toContain("Neighbour reported hurt");

    // 2. The Treasurer reads it, asks a caretaker, and cannot fund or move the held cat.
    let [read, asked, funded, moved] = await treasurer([
      { name: "list_reports", input: {} },
      { name: "ask_for_check", input: { report_id: report.id, question: "Is Tom walking on all four legs?", reason: "Tom was reported hurt by a neighbour, so a caretaker should look." } },
      { name: "fund_next_cat", input: { cat_id: tom.id, reason: "Tom goes first." } },
      { name: "set_cat_place", input: { cat_id: tom.id, before_cat_id: mimi.id, reason: "Tom goes ahead of Mimi.", report_id: report.id } },
    ]);
    expect(read.body.reports).toMatchObject([{ report_id: report.id, status: "open", standing: expect.any(String) }]);
    expect(asked.isError).toBe(false);
    expect(funded).toMatchObject({ isError: true, body: { code: "CAT_ON_HOLD" } });
    expect(moved.isError).toBe(true);
    expect(await db.select().from(allocations)).toHaveLength(0);
    l = await listed();
    expect(l.row("Tom")?.reason).toBe("Tom was reported hurt by a neighbour, so a caretaker should look.");
    expect(await timelineOf(tom.id)).toContain("Treasurer asked a caretaker to check");

    // 3. A caretaker confirms: the list now says a vet is next, whatever was asked before. Still held, still no move.
    await db.transaction((tx) => confirmReport(tx, report.id, caretaker.id));
    l = await listed();
    expect(l.needs).toEqual(["Tom"]);
    expect(l.row("Tom")).toMatchObject({ labels: ["Hurt", "Caretaker confirmed"], reason: "A caretaker confirmed this. A vet needs to check next." });
    expect(await timelineOf(tom.id)).toContain("Caretaker confirmed he's hurt");
    [funded, moved] = await treasurer([
      { name: "fund_next_cat", input: { cat_id: tom.id, reason: "Tom goes first." } },
      { name: "set_cat_place", input: { cat_id: tom.id, before_cat_id: mimi.id, reason: "Tom goes ahead of Mimi.", report_id: report.id } },
    ]);
    expect(funded.body.code).toBe("CAT_ON_HOLD");
    expect(moved.isError).toBe(true);

    // 4. A vet clears Tom: he joins the list to fund, behind Mimi, with the vet's mark.
    await db.transaction((tx) => clearCatForSurgery(tx, tom.id, vet.id));
    l = await listed();
    expect(l.needs).toEqual([]);
    expect(l.next).toEqual(["Mimi", "Tom"]);
    expect(l.row("Tom")?.labels).toEqual(["Vet ready"]);
    expect(await timelineOf(tom.id)).toContain("Vet cleared this cat for surgery");

    // 5. The Treasurer weighs it, moves Tom ahead citing the cleared report, and says who waits longer. The reason passes the public filter.
    const reason = "Tom goes ahead of Mimi, who has waited 14 days, because a vet cleared the report on Tom.";
    const [placed] = await treasurer([{ name: "set_cat_place", input: { cat_id: tom.id, before_cat_id: mimi.id, reason, report_id: report.id } }]);
    expect(placed.isError).toBe(false);
    l = await listed();
    expect(l.next).toEqual(["Tom", "Mimi"]);
    expect(l.row("Tom")?.reason).toBe(reason);
    expect(await timelineOf(tom.id)).toContain("Treasurer changed this cat's place");

    // 6. fund_next_cat funds Tom, the new top, with the same order the code uses. Mimi still waits.
    const [fundedTom] = await treasurer([{ name: "fund_next_cat", input: { cat_id: tom.id, reason: "Tom is first now, with a vet's clearance." } }]);
    expect(fundedTom).toMatchObject({ isError: false, body: { status: "funded", amount: PACKAGE } });
    l = await listed();
    expect(l.next).toEqual(["Mimi"]);
    expect(l.needs).toEqual([]);
    expect(await timelineOf(tom.id)).toContain("Treasurer funded this cat");
    expect(await db.select().from(allocations)).toHaveLength(1);
  });

  it("a dismissed report ends the hold and the cat goes back by the ranking, and the timeline says it was closed", async () => {
    const { mimi, tom, caretaker, report } = await world();
    const [asked] = await treasurer([
      { name: "ask_for_check", input: { report_id: report.id, question: "Is Tom limping?", reason: "A neighbour reported Tom hurt, so a caretaker should look." } },
    ]);
    expect(asked.isError).toBe(false);
    expect((await listed()).needs).toEqual(["Tom"]);

    await db.transaction((tx) => dismissReport(tx, report.id, caretaker.id));
    const l = await listed();
    expect(l.needs).toEqual([]);
    expect(l.next).toEqual(["Mimi", "Tom"]);
    expect(l.row("Tom")?.labels).toEqual([]);
    expect(await timelineOf(tom.id)).toEqual(expect.arrayContaining(["Neighbour reported hurt", "A caretaker checked this report and closed it."]));
    expect((await db.select().from(reports).where(eq(reports.id, report.id)))[0].status).toBe("dismissed");

    // A move cannot cite a dismissed report, and funding follows the ranking: Mimi first.
    const [moved, fundedTom, fundedMimi] = await treasurer([
      { name: "set_cat_place", input: { cat_id: tom.id, before_cat_id: mimi.id, reason: "Tom goes ahead of Mimi.", report_id: report.id } },
      { name: "fund_next_cat", input: { cat_id: tom.id, reason: "Tom goes first." } },
      { name: "fund_next_cat", input: { cat_id: mimi.id, reason: "Mimi is first and has waited longest." } },
    ]);
    expect(moved.isError).toBe(true);
    expect(fundedTom.isError).toBe(true);
    expect(fundedMimi).toMatchObject({ isError: false, body: { status: "funded" } });
  });
});
