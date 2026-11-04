import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { cats, reports, sightings, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

import { POST as clearPost } from "../src/app/api/vet/cats/[id]/clear/route";
import { GET as imageGet } from "../src/app/api/caretaker/images/[kind]/[id]/route";
import { Reports } from "../src/components/desk/ReportSection";
import { DESK_SECTIONS, deskTotal, waitingSections } from "../src/lib/deskSections";
import { runAction } from "../src/server/caretaker";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { heldCatIds } from "../src/server/reports";
import { SESSION_COOKIE, signSession, type Role } from "../src/server/session";
import { listVetDashboard } from "../src/server/vetFlow";

let seq = 0;
async function makeUser(role: Role) {
  const [u] = await db.insert(users).values({ username: `${role}_${Date.now()}_${++seq}`, role }).returning();
  return u;
}
async function signIn(u: { id: string; username: string }, role: Role) {
  jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role, username: u.username }));
}
async function makeCat(over: Partial<typeof cats.$inferInsert> = {}) {
  const [c] = await db.insert(cats).values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "spotted", ...over }).returning();
  return c;
}
async function makeSighting(over: Partial<typeof sightings.$inferInsert> = {}) {
  const [s] = await db.insert(sightings).values({ originalKey: `k${++seq}`, state: "matched", ...over }).returning();
  return s;
}
let day = 0;
async function makeReport(over: Partial<typeof reports.$inferInsert> = {}) {
  const [r] = await db
    .insert(reports)
    .values({ claim: "injured", source: "neighbour", reportedOn: new Date(Date.UTC(2026, 0, 1 + ++day)).toISOString().slice(0, 10), ...over })
    .returning();
  return r;
}
const reportRow = async (id: string) => (await db.select().from(reports).where(eq(reports.id, id)))[0];

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

describe("the reports section of the desk", () => {
  it("is the first section, and the jump row and the total count it", async () => {
    expect(DESK_SECTIONS[0].id).toBe("reports");
    const cat = await makeCat();
    await makeReport({ catId: cat.id, sightingId: (await makeSighting({ catId: cat.id })).id });
    const q = await getCaretakerQueue();
    expect(waitingSections(q)[0]).toMatchObject({ id: "reports", n: 1 });
    expect(deskTotal(q)).toBe(deskTotal({ ...q, reports: [] }) + 1);
  });

  it("is drawn before the approvals on the page", () => {
    const page = readFileSync(new URL("../src/app/caretaker/page.tsx", import.meta.url), "utf8");
    expect(page.indexOf("<Reports ")).toBeGreaterThan(-1);
    expect(page.indexOf("<Reports ")).toBeLessThan(page.indexOf("<Approvals "));
  });

  it("lists open reports only", async () => {
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id });
    await makeReport({ catId: cat.id, sightingId: s.id, status: "confirmed", claim: "sick" });
    await makeReport({ catId: cat.id, sightingId: s.id, status: "dismissed", claim: "pregnant" });
    await makeReport({ catId: cat.id, sightingId: s.id, status: "cleared", claim: "kitten" });
    const open = await makeReport({ catId: cat.id, sightingId: s.id });
    expect((await getCaretakerQueue()).reports.map((r) => r.id)).toEqual([open.id]);
  });

  it("sorts checks first, then hurt and sick, pregnant, kitten, then oldest, with one photo's reports together", async () => {
    const cat = await makeCat();
    const plain = async (claim: "injured" | "sick" | "pregnant" | "kitten", over: Partial<typeof reports.$inferInsert> = {}) =>
      makeReport({ catId: cat.id, sightingId: (await makeSighting({ catId: cat.id })).id, claim, ...over });
    const kitten = await plain("kitten");
    const pregnant = await plain("pregnant");
    const sick = await plain("sick");
    const hurtLater = await plain("injured");
    const askedKitten = await plain("kitten", { checkQuestion: "Is the leg bent?" });
    // Two reports from one photo: the one with a note leads its group, and the group sits where its best member does.
    const shared = await makeSighting({ catId: cat.id });
    const bare = await makeReport({ catId: cat.id, sightingId: shared.id, claim: "injured", source: "photo" });
    const noted = await makeReport({ catId: cat.id, sightingId: shared.id, claim: "sick", note: "limping" });
    const ids = (await getCaretakerQueue()).reports.map((r) => r.id);
    expect(ids[0]).toBe(askedKitten.id);
    expect(ids.indexOf(noted.id)).toBe(ids.indexOf(bare.id) - 1);
    expect(Math.abs(ids.indexOf(noted.id) - ids.indexOf(bare.id))).toBe(1);
    const rest = ids.filter((i) => ![askedKitten.id, bare.id, noted.id].includes(i));
    expect(rest).toEqual([sick.id, hurtLater.id, pregnant.id, kitten.id]);
    expect(ids.indexOf(noted.id)).toBeLessThan(ids.indexOf(pregnant.id));
  });

  it("shows a report with no cat as one to sort first, without buttons", async () => {
    const s = await makeSighting({ state: "needs_review", catId: null });
    await makeReport({ sightingId: s.id, note: "bleeding" });
    const q = await getCaretakerQueue();
    const html = renderToStaticMarkup(createElement(Reports, { items: q.reports }));
    expect(html).toContain("Sort this photo below first.");
    expect(html).not.toContain("Confirm");
    expect(html).not.toContain("Dismiss");
  });

  it("shows the photo, claim, who said it, the note, whether the photo agrees, the question and both buttons", async () => {
    const cat = await makeCat({ name: "Mochi" });
    const s = await makeSighting({ catId: cat.id });
    await makeReport({ catId: cat.id, sightingId: s.id, note: "limping badly", photoAgrees: true, checkQuestion: "Is it putting weight on the leg?" });
    await makeReport({ catId: cat.id, sightingId: s.id, claim: "sick", note: "thin", photoAgrees: false });
    await makeReport({ catId: cat.id, sightingId: s.id, claim: "pregnant", source: "photo" });
    const q = await getCaretakerQueue();
    const html = renderToStaticMarkup(createElement(Reports, { items: q.reports }));
    expect(html).toContain(`/api/caretaker/images/sighting/${s.id}`);
    expect(html).toContain("Neighbour says");
    expect(html).toContain("The AI thinks this photo shows");
    expect(html).toContain("limping badly");
    expect(html).toContain("The photo seems to show this");
    expect(html).toContain("The photo doesn&#x27;t clearly show this");
    expect(html).toContain("Is it putting weight on the leg?");
    expect(html).toContain("Mochi");
    expect((html.match(/>Confirm</g) ?? []).length).toBe(3);
    expect((html.match(/>Dismiss</g) ?? []).length).toBe(3);
    // The photo report has no agreement line of its own.
    const photoCard = html.split("<li").find((c) => c.includes("The AI thinks this photo shows"))!;
    expect(photoCard).not.toContain("The photo seems to show this");
    expect(photoCard).not.toContain("clearly show this");
  });
});

describe("report_confirm and report_dismiss", () => {
  it("confirm flags the cat and keeps it held; dismiss lets it go", async () => {
    const care = await makeUser("caretaker");
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id });
    const a = await makeReport({ catId: cat.id, sightingId: s.id });
    const b = await makeReport({ catId: cat.id, sightingId: s.id, claim: "sick" });
    expect(await runAction("report_confirm", care.id, { reportId: a.id })).toMatchObject({ ok: true, tone: "ok" });
    expect((await reportRow(a.id)).status).toBe("confirmed");
    expect(await runAction("report_dismiss", care.id, { reportId: b.id })).toMatchObject({ ok: true, tone: "ok" });
    expect((await reportRow(b.id)).status).toBe("dismissed");
    expect((await db.select().from(cats).where(eq(cats.id, cat.id)))[0].flags).toContain("injured");
    expect((await db.transaction((tx) => heldCatIds(tx))).has(cat.id)).toBe(true);
  });

  it("a repeat tap changes nothing and says so plainly", async () => {
    const care = await makeUser("caretaker");
    const cat = await makeCat();
    const r = await makeReport({ catId: cat.id, sightingId: (await makeSighting({ catId: cat.id })).id });
    await runAction("report_dismiss", care.id, { reportId: r.id });
    const again = await runAction("report_confirm", care.id, { reportId: r.id });
    expect(again).toMatchObject({ status: 200, ok: true, tone: "warn", message: "Someone has already decided this report." });
    expect((await reportRow(r.id)).status).toBe("dismissed");
  });

  it("a report with no cat cannot be decided here", async () => {
    const care = await makeUser("caretaker");
    const r = await makeReport({ sightingId: (await makeSighting({ state: "needs_review" })).id });
    const out = await runAction("report_confirm", care.id, { reportId: r.id });
    expect(out.message).toBe("Sort this photo below first.");
    expect((await reportRow(r.id)).status).toBe("open");
  });

  it("refuses an account that is not a caretaker, and a bad id", async () => {
    const vet = await makeUser("vet");
    const cat = await makeCat();
    const r = await makeReport({ catId: cat.id, sightingId: (await makeSighting({ catId: cat.id })).id });
    expect((await runAction("report_confirm", vet.id, { reportId: r.id })).status).toBe(403);
    expect((await runAction("report_confirm", vet.id, { reportId: "nope" })).status).toBe(400);
    expect((await reportRow(r.id)).status).toBe("open");
  });
});

describe("the demo desk", () => {
  it("hides a real note and a real question, and shows a sample row's", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id });
    await makeReport({ catId: cat.id, sightingId: s.id, note: "call me on 0917 123 4567", checkQuestion: "Is it near 12 Rizal Ave?" });
    await makeReport({ catId: cat.id, sightingId: s.id, claim: "sick", note: "sample note", sample: true });
    const q = await getCaretakerQueue();
    const real = q.reports.find((r) => r.claim === "injured")!;
    const sample = q.reports.find((r) => r.claim === "sick")!;
    expect(real.note).toBe("Hidden in the demo");
    expect(real.checkQuestion).toBeNull();
    expect(JSON.stringify(q.reports.filter((r) => !r.sample))).not.toMatch(/0917|Rizal/);
    expect(sample.note).toBe("sample note");
  });

  it("serves a real report's photo as the plain hidden picture", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const care = await makeUser("caretaker");
    await signIn(care, "caretaker");
    const cat = await makeCat();
    const s = await makeSighting({ catId: cat.id, publicReady: false });
    await makeReport({ catId: cat.id, sightingId: s.id });
    const res = await imageGet(new Request("http://x"), { params: Promise.resolve({ kind: "sighting", id: s.id }) });
    expect(await res.text()).toContain("Hidden in the demo");
  });

  it("with the demo off, a caretaker reads the real note", async () => {
    const cat = await makeCat();
    await makeReport({ catId: cat.id, sightingId: (await makeSighting({ catId: cat.id })).id, note: "limping" });
    expect((await getCaretakerQueue()).reports[0].note).toBe("limping");
  });
});

describe("the vet's clear", () => {
  const post = (catId: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    clearPost(new Request("http://x/api/vet/cats/x/clear", { method: "POST", headers, body: "{}" }), { params: Promise.resolve({ id: catId }) });

  it("lists confirmed held cats only", async () => {
    const vet = await makeUser("vet");
    const held = await makeCat();
    const open = await makeCat();
    const kitten = await makeCat();
    const cleared = await makeCat();
    await makeReport({ catId: held.id, status: "confirmed" });
    await makeReport({ catId: open.id, status: "open" });
    await makeReport({ catId: kitten.id, status: "confirmed", claim: "kitten" });
    await makeReport({ catId: cleared.id, status: "cleared" });
    const d = await listVetDashboard(vet.id);
    expect(d.checkCats.map((c) => c.id)).toEqual([held.id]);
  });

  it("refuses anyone who is not a vet, with 403", async () => {
    const care = await makeUser("caretaker");
    await signIn(care, "caretaker");
    const cat = await makeCat();
    await makeReport({ catId: cat.id, status: "confirmed" });
    expect((await post(cat.id)).status).toBe(403);
    expect((await db.select().from(reports))[0].status).toBe("confirmed");
  });

  it("refuses a request that is not JSON, so another site cannot post to it", async () => {
    const vet = await makeUser("vet");
    await signIn(vet, "vet");
    const cat = await makeCat();
    await makeReport({ catId: cat.id, status: "confirmed" });
    expect((await post(cat.id, { "content-type": "text/plain" })).status).toBe(415);
    expect((await db.select().from(reports))[0].status).toBe("confirmed");
  });

  it("will not clear a cat with no confirmed report", async () => {
    const vet = await makeUser("vet");
    await signIn(vet, "vet");
    const cat = await makeCat();
    const r = await makeReport({ catId: cat.id, status: "open" });
    expect((await post(cat.id)).status).toBe(409);
    expect((await reportRow(r.id)).status).toBe("open");
  });

  it("clears a confirmed cat, and clearing twice changes nothing more", async () => {
    const vet = await makeUser("vet");
    await signIn(vet, "vet");
    const cat = await makeCat({ flags: ["injured"] });
    const r = await makeReport({ catId: cat.id, status: "confirmed" });
    expect((await post(cat.id)).status).toBe(200);
    expect((await reportRow(r.id)).status).toBe("cleared");
    expect((await db.transaction((tx) => heldCatIds(tx))).has(cat.id)).toBe(false);
    const again = await post(cat.id);
    expect(again.status).toBe(409);
    expect((await reportRow(r.id)).status).toBe("cleared");
    expect((await db.select().from(cats).where(eq(cats.id, cat.id)))[0].flags).toEqual(["injured"]);
  });

  it("answers a bad cat id with 404", async () => {
    const vet = await makeUser("vet");
    await signIn(vet, "vet");
    expect((await post("not-a-uuid")).status).toBe(404);
  });
});
