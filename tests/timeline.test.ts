import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { agentActions, cats, reports, treatments } from "../src/server/db/schema";
import { catTimeline, TIMELINE_LIMIT } from "../src/server/timeline";
import { truncateAll } from "./helpers/db";
import { addPayout, makeBooking, makeCaretaker, makeVet } from "./helpers/payoutFixtures";
import { eq } from "drizzle-orm";

const day = (d: number, h = 8) => new Date(Date.UTC(2026, 10, d, h));
const NOTE = "ask for Aling Rosa at the corner stall";

async function cat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name: "Bituin", areaName: "Brgy 1", status: "queued", ...over }).returning();
  return c;
}
type R = Partial<typeof reports.$inferInsert> & { catId: string | null };
async function report(r: R) {
  const [row] = await db
    .insert(reports)
    .values({ claim: "injured", source: "neighbour", reportedOn: "2026-11-03", createdAt: day(3), ...r })
    .returning();
  return row;
}
const titles = async (id: string) => (await catTimeline(id)).map((e) => e.title);

describe("a cat's timeline", () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  it("sorts by time, oldest first, with care steps still to come after the rest", async () => {
    const c = await cat();
    const staff = await makeCaretaker();
    await report({ catId: c.id, createdAt: day(5) });
    await report({ catId: c.id, claim: "sick", createdAt: day(2), status: "confirmed", decidedBy: staff.id, decidedAt: day(4) });
    const t = await catTimeline(c.id);
    const done = t.filter((e) => e.done);
    expect(done.map((e) => e.at)).toEqual([...done.map((e) => e.at)].sort());
    const firstTodo = t.findIndex((e) => !e.done);
    expect(firstTodo).toBeGreaterThan(0);
    expect(t.slice(firstTodo).every((e) => !e.done)).toBe(true);
    expect(t.slice(firstTodo).map((e) => e.title)).toEqual(["Neutered", "Vaccinated", "Dewormed", "Adoptable", "Adopted"]);
  });

  it("a neighbour's report says hurt and holds no name or note", async () => {
    const c = await cat();
    const staff = await makeCaretaker();
    await report({ catId: c.id, note: NOTE, reporterId: staff.id });
    const t = await catTimeline(c.id);
    expect(t.map((e) => e.title)).toContain("Neighbour reported hurt");
    const json = JSON.stringify(t);
    expect(json).not.toContain("Aling");
    expect(json).not.toContain(staff.username);
    expect(json).not.toContain(staff.id);
  });

  it("uses claim words, and a photo's report reads as a suggestion", async () => {
    const c = await cat();
    await report({ catId: c.id, source: "photo", claim: "injured" });
    await report({ catId: c.id, claim: "pregnant", createdAt: day(4) });
    await report({ catId: c.id, claim: "sick", createdAt: day(5) });
    await report({ catId: c.id, claim: "kitten", createdAt: day(6) });
    const t = await titles(c.id);
    expect(t).toContain("A photo suggests this cat is hurt");
    expect(t).toContain("Neighbour reported pregnant");
    expect(t).toContain("Neighbour reported sick");
    expect(t).toContain("Neighbour said this cat may be a kitten");
  });

  it("a confirm uses the cat's confirmed sex, and never an unconfirmed answer", async () => {
    const staff = await makeCaretaker();
    const girl = await cat({ sex: "female" });
    const guess = await cat({ name: "Guess", sex: "female", sexUnconfirmed: true });
    const unknown = await cat({ name: "Who" });
    for (const c of [girl, guess, unknown]) {
      await report({ catId: c.id, status: "confirmed", decidedBy: staff.id, decidedAt: day(4) });
    }
    expect(await titles(girl.id)).toContain("Caretaker confirmed she's hurt");
    expect(await titles(guess.id)).toContain("Caretaker confirmed this cat is hurt");
    expect(await titles(unknown.id)).toContain("Caretaker confirmed this cat is hurt");
    const boy = await cat({ name: "Boy", sex: "male" });
    await report({ catId: boy.id, claim: "pregnant", status: "confirmed", decidedBy: staff.id, decidedAt: day(4) });
    expect(await titles(boy.id)).toContain("Caretaker confirmed he's pregnant");
  });

  it("a dismiss says the cat was checked, and a report closed with nobody deciding shows nothing", async () => {
    const c = await cat();
    const staff = await makeCaretaker();
    await report({ catId: c.id, status: "dismissed", decidedBy: staff.id, decidedAt: day(4) });
    await report({ catId: c.id, claim: "sick", status: "dismissed", decidedBy: null, decidedAt: day(4) });
    const t = await titles(c.id);
    expect(t).toContain("Neighbour reported hurt");
    expect(t).toContain("A caretaker checked this report and closed it.");
    expect(t.some((x) => /sick/.test(x))).toBe(false);
  });

  it("a report with no cat is on no timeline", async () => {
    const c = await cat();
    await report({ catId: null });
    expect((await titles(c.id)).some((x) => /reported/.test(x))).toBe(false);
  });

  it("a vet's clear reads as one row, and the earlier confirm keeps its own time", async () => {
    const c = await cat({ sex: "female" });
    const vet = await makeVet();
    const staff = await makeCaretaker();
    const a = await report({ catId: c.id, status: "cleared", decidedBy: vet.id, decidedAt: day(7) });
    const b = await report({ catId: c.id, claim: "sick", status: "cleared", decidedBy: vet.id, decidedAt: day(7) });
    for (const r of [a, b]) {
      await db.insert(agentActions).values({ action: "report_confirmed", reason: "A caretaker confirmed a report.", status: "done", approvedBy: staff.id, inputs: { reportId: r.id, catId: c.id, claim: r.claim }, createdAt: day(4) });
    }
    const t = await catTimeline(c.id);
    expect(t.filter((e) => e.title === "Vet cleared this cat for surgery")).toHaveLength(1);
    const confirm = t.find((e) => e.title === "Caretaker confirmed she's hurt");
    expect(confirm?.at).toBe(day(4).toISOString());
    expect(t.findIndex((e) => e.title === "Caretaker confirmed she's hurt")).toBeLessThan(t.findIndex((e) => e.title === "Vet cleared this cat for surgery"));
  });

  it("a Treasurer row shows its reason only when it is safe, and only for this cat", async () => {
    const c = await cat();
    const other = await cat({ name: "Mocha" });
    await report({ catId: other.id, note: NOTE });
    const add = (action: string, reason: string, catId: string, at: Date, extra: object = {}) =>
      db.insert(agentActions).values({ action, reason, status: "done", inputs: { catId, ...extra }, createdAt: at });
    await add("ask_for_check", "The photo does not show the leg, so someone should look.", c.id, day(3));
    await add("set_cat_place", `Bituin waits because ${NOTE}.`, c.id, day(4));
    await add("fund_cat", "Bituin was next and the fund covered it.", c.id, day(8));
    await add("fund_cat", "Mocha was next.", other.id, day(8));
    await add("report_confirmed", "A caretaker confirmed a report.", c.id, day(4));
    await add("cat_updated", "A caretaker updated a cat's card.", c.id, day(4));
    const t = await catTimeline(c.id);
    const ai = t.filter((e) => e.kind === "ai");
    expect(ai.map((e) => e.title)).toEqual(["Treasurer asked a caretaker to check", "Treasurer changed this cat's place", "Treasurer funded this cat"]);
    expect(ai.map((e) => e.detail)).toEqual([
      "The photo does not show the leg, so someone should look.",
      "The Treasurer changed the order after a check.",
      "Bituin was next and the fund covered it.",
    ]);
    expect(JSON.stringify(t)).not.toContain("Mocha was next");
  });

  it("a payment reads by its status, links to the Ledger and shows no amount or PayPal reference", async () => {
    const c = await cat();
    const vet = await makeVet();
    const mk = async (kind: "deposit" | "balance", status: string, at: Date) => {
      const booking = await makeBooking(c.id, vet.id, "completed");
      const p = await addPayout({ cat: c, vet, booking }, { amount: 4_567_00, status, kind, createdAt: at, batchId: "BATCH-SECRET" });
      return p;
    };
    await mk("deposit", "succeeded", day(8));
    await mk("balance", "sent", day(9));
    await mk("balance", "awaiting_approval", day(10));
    await mk("deposit", "failed", day(11));
    await mk("balance", "rejected", day(12));
    const t = await catTimeline(c.id);
    const pp = t.filter((e) => e.kind === "paypal");
    expect(pp.map((e) => e.title)).toEqual([
      "Deposit paid through PayPal",
      "Waiting for PayPal",
      "Waiting for a caretaker",
      "A deposit didn't go through",
      "A balance payment wasn't paid",
    ]);
    expect(pp.every((e) => e.ledger)).toBe(true);
    expect(t.filter((e) => e.kind !== "paypal").every((e) => !e.ledger)).toBe(true);
    const json = JSON.stringify(t);
    expect(json).not.toContain("BATCH-SECRET");
    expect(json).not.toContain("4567");
    expect(json).not.toContain("45670");
  });

  it("a balance paid through PayPal reads as the balance", async () => {
    const c = await cat();
    const vet = await makeVet();
    const booking = await makeBooking(c.id, vet.id);
    await addPayout({ cat: c, vet, booking }, { amount: 1000, status: "succeeded", kind: "balance", createdAt: day(9) });
    expect(await titles(c.id)).toContain("Balance paid through PayPal");
  });

  it("care steps keep their dates", async () => {
    const c = await cat({ status: "neutered" });
    await db.insert(treatments).values({ catId: c.id, type: "neuter", date: "2026-11-09" });
    await db.insert(treatments).values({ catId: c.id, type: "vaccine", date: "2026-11-09" });
    const t = await catTimeline(c.id);
    expect(t.find((e) => e.title === "Neutered")).toMatchObject({ done: true, day: "2026-11-09" });
    expect(t.find((e) => e.title === "Vaccinated")).toMatchObject({ done: true, day: "2026-11-09" });
    expect(t.find((e) => e.title === "Dewormed")).toMatchObject({ done: false });
  });

  it("a care step with only a date sorts after the timed events of that Manila day, and before the next day's", async () => {
    const c = await cat({ status: "neutered", createdAt: new Date(Date.UTC(2026, 10, 1)) });
    await db.insert(treatments).values({ catId: c.id, type: "neuter", date: "2026-11-09" });
    await report({ catId: c.id, createdAt: day(9, 0) }); // 08:00 Manila on the 9th
    await report({ catId: c.id, claim: "sick", createdAt: day(9, 10), reportedOn: "2026-11-09" }); // 18:00 Manila on the 9th
    await report({ catId: c.id, claim: "pregnant", createdAt: day(9, 17), reportedOn: "2026-11-10" }); // 01:00 Manila on the 10th
    const done = (await catTimeline(c.id)).filter((e) => e.done).map((e) => e.title);
    expect(done).toEqual(["First spotted", "Neighbour reported hurt", "Neighbour reported sick", "Neutered", "Neighbour reported pregnant"]);
  });

  it("keeps the first row and the newest ones when the history is long", async () => {
    const c = await cat({ createdAt: new Date(Date.UTC(2026, 8, 1)) });
    for (let i = 0; i < TIMELINE_LIMIT + 8; i++) {
      await report({ catId: c.id, claim: i % 2 ? "sick" : "injured", source: "caretaker", status: "confirmed", reportedOn: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) });
    }
    const done = (await catTimeline(c.id)).filter((e) => e.done);
    expect(done).toHaveLength(TIMELINE_LIMIT);
    expect(done[0].title).toBe("First spotted");
  });

  it("builds each entry field by field", async () => {
    const c = await cat();
    await report({ catId: c.id, note: NOTE });
    for (const e of await catTimeline(c.id)) {
      expect(Object.keys(e).sort()).toEqual(["at", "day", "detail", "done", "kind", "ledger", "title"]);
    }
  });

  it("leaves another cat's notes out of this timeline", async () => {
    const c = await cat();
    const other = await cat({ name: "Mocha" });
    await report({ catId: other.id, note: NOTE });
    expect(JSON.stringify(await catTimeline(c.id))).not.toContain("Aling");
    expect(await db.select().from(reports).where(eq(reports.catId, other.id))).toHaveLength(1);
  });
});

describe("the timeline as shown", () => {
  it("marks each kind with a word as well as colour, links payments to the Ledger and leaves steps ahead plain", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { CatTimeline } = await import("../src/components/CatTimeline");
    const html = renderToStaticMarkup(
      createElement(CatTimeline, {
        entries: [
          { at: "2026-11-02", day: "2026-11-02", kind: "person", title: "First spotted", detail: null, ledger: false, done: true },
          { at: "2026-11-04T01:00:00.000Z", day: "2026-11-04", kind: "ai", title: "Treasurer changed this cat's place", detail: "A reason.", ledger: false, done: true },
          { at: "2026-11-08T01:00:00.000Z", day: "2026-11-08", kind: "paypal", title: "Deposit paid through PayPal", detail: null, ledger: true, done: true },
          { at: null, day: null, kind: "person", title: "Neutered", detail: null, ledger: false, done: false },
        ],
      }),
    );
    for (const w of ["A person", "The Treasurer (AI)", "PayPal", "See it on the Ledger", 'href="/ledger"', "(not yet)", "4 Nov 2026"]) expect(html).toContain(w);
    expect(html).not.toContain("—");
    expect(html.match(/See it on the Ledger/g)).toHaveLength(1);
  });
});
