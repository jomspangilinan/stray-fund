import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { closePool, db } from "../src/server/db/client";
import { agentActions, allocations, cats, donations, guardrails, reports, sightings, treatments, users } from "../src/server/db/schema";
import { placeCat } from "../src/server/agent/priority";
import { truncateAll } from "./helpers/db";
import {
  catForViewer,
  getCatCard,
  getCatForViewer,
  getHelpedEntries,
  getHelped,
  getPriorityList,
  listAgentActions,
  noteEchoes,
  noteGramsOf,
  getUnallocated,
  journey,
  listCats,
  publicCat,
  publicLedgerRow,
  publicSighting,
} from "../src/server/public";
import { CatRow } from "../src/components/CatRow";
import { CatDetail } from "../src/components/CatDetail";
import { GET as catGet } from "../src/app/api/cats/[id]/route";
import { GET as priorityGet } from "../src/app/api/priority/route";
import { PriorityList } from "../src/components/PriorityList";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));
import { SESSION_COOKIE, signSession } from "../src/server/session";

// Sentinels: distinct values that must never appear in any public output.
const EXACT_LAT = 10.987654321;
const EXACT_LNG = 120.123456789;
const FUZZ_LAT = 10.55555555;
const FUZZ_LNG = 120.66666666;
const S_EXACT_LAT = 11.246813579;
const S_EXACT_LNG = 121.135792468;
const EMAIL = "secret.sentinel@example.test";
const ORIGINAL_KEY = "originals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg";
const PUBLIC_KEY = "photos/11111111-2222-3333-4444-555555555555.jpg";
const SENTINELS = [
  String(EXACT_LAT), String(EXACT_LNG), String(FUZZ_LAT), String(FUZZ_LNG),
  String(S_EXACT_LAT), String(S_EXACT_LNG), EMAIL, ORIGINAL_KEY, "exact_lat", "exactLat",
  "fuzzed", "original_key", "originalKey", "locationApproximate", "location_approximate",
  "paypal_email", "paypalEmail", "assessment", "requested_sex",
];

function expectClean(text: string) {
  for (const s of SENTINELS) expect(text, `leaked ${s}`).not.toContain(s);
}

let seq = 0;
async function seed() {
  const [vet] = await db.insert(users).values({ username: "vet_one", role: "vet", paypalEmail: EMAIL }).returning();
  const [cat] = await db
    .insert(cats)
    .values({
      name: "Mimi",
      sex: "female",
      status: "neutered",
      flags: ["pregnant"],
      areaName: "Brgy. San Antonio, near the market",
      exactLat: EXACT_LAT,
      exactLng: EXACT_LNG,
      fuzzedLat: FUZZ_LAT,
      fuzzedLng: FUZZ_LNG,
      locationApproximate: true,
      bio: "Sleeps by the bakery.",
      createdAt: new Date("2026-02-01T10:00:00Z"),
    })
    .returning();
  await db.insert(sightings).values([
    {
      catId: cat.id,
      originalKey: ORIGINAL_KEY,
      publicKey: PUBLIC_KEY,
      publicReady: true,
      takenAt: new Date("2026-02-01T17:30:00Z"), // 2026-02-02 01:30 in Manila
      exactLat: S_EXACT_LAT,
      exactLng: S_EXACT_LNG,
      requestedSex: "female",
      assessment: { secret: "assess" },
      state: "new_cat",
    },
    {
      catId: cat.id,
      originalKey: ORIGINAL_KEY,
      publicKey: null,
      publicReady: false,
      takenAt: new Date("2026-02-05T04:00:00Z"),
      exactLat: S_EXACT_LAT,
      exactLng: S_EXACT_LNG,
      state: "matched",
    },
  ]);
  await db.insert(treatments).values({
    catId: cat.id,
    type: "neuter",
    product: null,
    date: "2026-03-01",
    vetId: vet.id,
  });
  return { cat, vet };
}

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-1234";
});
afterAll(closePool);

describe("serializers", () => {
  it("publicCat is a whitelist: no coordinates, keys or flags detail leak", async () => {
    const { cat } = await seed();
    const card = await getCatCard(cat.id);
    expect(card).not.toBeNull();
    const json = JSON.stringify(card);
    expectClean(json);
    expect(card!.cat).toMatchObject({
      name: "Mimi",
      sex: "Female",
      status: "neutered",
      area: "Brgy. San Antonio, near the market",
      sightingCount: 2,
    });
    expect(Object.keys(card!.cat).sort()).toEqual(
      ["area", "bio", "earTipped", "flags", "id", "journey", "name", "photoUrl", "sex", "sightingCount", "status", "statusLabel"].sort(),
    );
  });

  it("publicCat never spreads the row", () => {
    const row = { ...({} as typeof cats.$inferSelect), id: "x", name: "N", sex: "male", status: "spotted", flags: [], areaName: "A", exactLat: 1.2345, exactLng: 2.3456, bio: null, earTipped: null, createdAt: new Date(), extra: "zzz" } as typeof cats.$inferSelect;
    const out = publicCat(row, { photoKey: null, sightingCount: 0, treatments: [] });
    expect(JSON.stringify(out)).not.toContain("1.2345");
    expect(JSON.stringify(out)).not.toContain("zzz");
  });

  it("sighting timestamps are public as date only (Asia/Manila)", async () => {
    const { cat } = await seed();
    const card = await getCatCard(cat.id);
    const dates = card!.sightings.map((s) => s.date).sort();
    expect(dates).toEqual(["2026-02-02", "2026-02-05"]);
    expect(JSON.stringify(card!.sightings)).not.toMatch(/T\d\d:\d\d/);
    expect(Object.keys(card!.sightings[0]).sort()).toEqual(["date", "id", "photoUrl"]);
  });

  it("public_ready=false photos show a placeholder", async () => {
    const { cat } = await seed();
    const card = await getCatCard(cat.id);
    const notReady = card!.sightings.find((s) => s.date === "2026-02-05")!;
    expect(notReady.photoUrl).toBeNull();
    const ready = card!.sightings.find((s) => s.date === "2026-02-02")!;
    expect(ready.photoUrl).toContain(PUBLIC_KEY);
    const s = publicSighting({ id: "s", takenAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), publicKey: PUBLIC_KEY, publicReady: false });
    expect(s.photoUrl).toBeNull();
    const html = renderToStaticMarkup(createElement(CatRow, { cat: { ...card!.cat, photoUrl: null } }));
    expect(html).toContain("No photo yet");
    expect(html).not.toContain("<img");
  });

  it("publicLedgerRow whitelists fields", () => {
    const row = publicLedgerRow({
      date: new Date("2026-01-01T00:00:00Z"), type: "donation", amount: 100, fee: 10, cat: null, catId: null,
      reason: null, paypalId: "X", status: "captured", who: "maria", email: EMAIL, userId: "u1",
    } as never);
    expect(JSON.stringify(row)).not.toContain(EMAIL);
    expect(Object.keys(row).sort()).toEqual(["amount", "cat", "catId", "date", "fee", "paypalId", "reason", "status", "type", "who"]);
  });
});

describe("viewer access to exact location", () => {
  beforeEach(() => vi.stubEnv("DEMO_MODE", "false")); // staff see exact places only outside the demo
  afterEach(() => vi.unstubAllEnvs());
  async function viewers() {
    const { cat } = await seed();
    const [donor] = await db.insert(users).values({ username: "donor_a", role: "donor" }).returning();
    const [caretaker] = await db.insert(users).values({ username: "care_a", role: "caretaker" }).returning();
    const [vet] = await db.insert(users).values({ username: "vet_a", role: "vet" }).returning();
    return { cat, donor, caretaker, vet };
  }
  const sess = (u: { id: string; username: string; role: string }) =>
    ({ userId: u.id, username: u.username, role: u.role }) as never;

  it("donor and anonymous viewers never get exact", async () => {
    const { cat, donor } = await viewers();
    const anon = await getCatForViewer(cat.id, null);
    const don = await getCatForViewer(cat.id, sess(donor));
    for (const v of [anon, don]) {
      expect(v).not.toBeNull();
      expect("exact" in v!).toBe(false);
      expectClean(JSON.stringify(v));
    }
  });

  it("caretaker and vet get exact with the approximate flag, never fuzzed", async () => {
    const { cat, caretaker, vet } = await viewers();
    for (const u of [caretaker, vet]) {
      const v = await getCatForViewer(cat.id, sess(u));
      expect(v!.exact).toEqual({ lat: EXACT_LAT, lng: EXACT_LNG, approximate: true });
      expect(JSON.stringify(v)).not.toContain(String(FUZZ_LAT));
    }
  });

  it("catForViewer is pure on role", async () => {
    const { cat } = await viewers();
    const [row] = await db.select().from(cats);
    const ctx = { photoKey: null, sightingCount: 0, treatments: [] };
    expect("exact" in catForViewer(row, null, ctx)).toBe(false);
    expect(catForViewer(row, { userId: "u", username: "u", role: "foster" }, ctx)).not.toHaveProperty("exact");
    expect(catForViewer(row, { userId: "u", username: "u", role: "vet" }, ctx).exact?.lat).toBe(EXACT_LAT);
    expect(cat.id).toBe(row.id);
  });
});

describe("GET /api/cats/[id]", () => {
  afterEach(() => vi.unstubAllEnvs());
  const call = (id: string) => catGet(new Request(`http://localhost/api/cats/${id}`), { params: Promise.resolve({ id }) });

  it("public payload is clean and cacheable-safe", async () => {
    const { cat } = await seed();
    const res = await call(cat.id);
    expect(res.status).toBe(200);
    expectClean(await res.text());
    expect(res.headers.get("cache-control")).not.toContain("no-store");
  });

  it("unknown id and invalid uuid are 404", async () => {
    expect((await call("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call("not-a-uuid")).status).toBe(404);
    expect((await call("1; drop table cats")).status).toBe(404);
  });

  it("caretaker gets exact and no-store", async () => {
    vi.stubEnv("DEMO_MODE", "false"); // staff see exact places only outside the demo
    const { cat } = await seed();
    const [u] = await db.insert(users).values({ username: "care_b", role: "caretaker" }).returning();
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: "caretaker", username: u.username }));
    const res = await call(cat.id);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.exact).toEqual({ lat: EXACT_LAT, lng: EXACT_LNG, approximate: true });
  });
});

describe("journey", () => {
  const base = { status: "spotted", earTipped: null as boolean | null, firstSeenAt: new Date("2026-02-01T10:00:00Z") };
  const t = (type: string, date: string) => ({ type, date, product: null, nextDue: null, vet: null, id: type + date });
  const steps = (j: ReturnType<typeof journey>) => j.map((s) => s.step);

  it("has the six steps in order", () => {
    expect(steps(journey(base, []))).toEqual(["Spotted", "Neutered", "Vaccinated", "Dewormed", "Adoptable", "Adopted"]);
  });

  it("dates derive from treatments", () => {
    const j = journey({ ...base, status: "neutered" }, [t("neuter", "2026-03-01"), t("vaccine", "2026-03-02"), t("deworming", "2026-03-03")]);
    expect(j.find((s) => s.step === "Spotted")).toMatchObject({ done: true, date: "2026-02-01" });
    expect(j.find((s) => s.step === "Neutered")).toMatchObject({ done: true, date: "2026-03-01" });
    expect(j.find((s) => s.step === "Vaccinated")).toMatchObject({ done: true, date: "2026-03-02" });
    expect(j.find((s) => s.step === "Dewormed")).toMatchObject({ done: true, date: "2026-03-03" });
    expect(j.find((s) => s.step === "Adoptable")?.done).toBe(false);
  });

  it("an ear-tipped arrival is neutered with no date and an honest label", () => {
    const j = journey({ ...base, status: "neutered", earTipped: true }, []);
    const n = j.find((s) => s.step === "Neutered")!;
    expect(n.done).toBe(true);
    expect(n.date).toBeUndefined();
    expect(n.note).toBe("Already neutered when found");
  });

  it("adoptable and adopted come from status", () => {
    const a = journey({ ...base, status: "adoptable" }, []);
    expect(a.find((s) => s.step === "Adoptable")?.done).toBe(true);
    expect(a.find((s) => s.step === "Adopted")?.done).toBe(false);
    const b = journey({ ...base, status: "adopted" }, []);
    expect(b.find((s) => s.step === "Adopted")?.done).toBe(true);
    expect(b.find((s) => s.step === "Adoptable")?.done).toBe(true);
    expect(b.find((s) => s.step === "Adopted")?.date).toBeUndefined();
  });

  it("health record flags overdue next-due in Asia/Manila", async () => {
    const { cat } = await seed();
    await db.insert(treatments).values([
      { catId: cat.id, type: "vaccine", product: "Rabies", date: "2020-01-01", nextDue: "2020-12-31" },
      { catId: cat.id, type: "deworming", product: "Drontal", date: "2020-01-01", nextDue: "2999-01-01" },
    ]);
    const card = await getCatCard(cat.id);
    const vac = card!.health.find((h) => h.type === "Vaccine")!;
    expect(vac).toMatchObject({ product: "Rabies", date: "2020-01-01", nextDue: "2020-12-31", overdue: true });
    expect(card!.health.find((h) => h.type === "Deworming")!.overdue).toBe(false);
    expect(card!.health.find((h) => h.type === "Neuter")!.vet).toBe("vet_one");
    expect(JSON.stringify(card!.health)).not.toContain("receipt");
  });
});

describe("listing", () => {
  it("filters by plain status groups and caps at 200", async () => {
    await db.insert(cats).values([
      { name: "A", status: "spotted", areaName: "x" },
      { name: "B", status: "in_care", areaName: "x" },
      { name: "C", status: "neutered", areaName: "x" },
      { name: "D", status: "adoptable", areaName: "x" },
    ]);
    expect((await listCats("waiting")).map((c) => c.name)).toEqual(["A"]);
    expect((await listCats("in-care")).map((c) => c.name)).toEqual(["B"]);
    expect((await listCats("neutered")).map((c) => c.name)).toEqual(["C"]);
    expect((await listCats("home")).map((c) => c.name)).toEqual(["D"]);
    expect((await listCats("all")).length).toBe(4);
    expect((await listCats("bogus")).length).toBe(4);
  });
});

describe("helped", () => {
  async function donor(name: string) {
    const [u] = await db.insert(users).values({ username: name, role: "donor" }).returning();
    return u;
  }
  async function don(userId: string, net: number, status = "captured") {
    seq += 1;
    const [d] = await db.insert(donations).values({ userId, gross: net, paypalFee: 0, net, paypalOrderId: `o-${seq}`, status }).returning();
    return d;
  }
  async function cat(name: string) {
    const [c] = await db.insert(cats).values({ name, areaName: "x" }).returning();
    return c;
  }
  const alloc = (donationId: string, catId: string, amount: number) =>
    db.insert(allocations).values({ donationId, catId, purpose: "vet", amount });

  it("includes split-funded cats for each donor, excludes fully returned allocations", async () => {
    const a = await donor("don_a");
    const b = await donor("don_b");
    const c1 = await cat("One");
    const c2 = await cat("Two");
    const c3 = await cat("Three");
    const da = await don(a.id, 10_000);
    const db_ = await don(b.id, 10_000);
    await alloc(da.id, c1.id, 6_000);
    await alloc(db_.id, c1.id, 4_000); // c1 split funded
    await alloc(da.id, c2.id, 3_000);
    await alloc(da.id, c2.id, -3_000); // fully returned
    await alloc(db_.id, c3.id, 2_000);

    expect((await getHelped(a.id)).map((c) => c.name)).toEqual(["One"]);
    expect((await getHelped(b.id)).map((c) => c.name).sort()).toEqual(["One", "Three"]);
    const entries = await getHelpedEntries(a.id);
    expect(entries.map((e) => [e.cat.name, e.amount])).toEqual([["One", 6_000]]);
  });

  it("ignores uncaptured donations and other donors", async () => {
    const a = await donor("don_c");
    const c1 = await cat("One");
    const pending = await don(a.id, 5_000, "pending");
    await alloc(pending.id, c1.id, 5_000);
    expect(await getHelped(a.id)).toEqual([]);
  });

  it("unallocated money is waiting in the pool", async () => {
    const a = await donor("don_d");
    const c1 = await cat("One");
    const d1 = await don(a.id, 10_000);
    expect(await getUnallocated(a.id)).toBe(10_000);
    await alloc(d1.id, c1.id, 4_000);
    expect(await getUnallocated(a.id)).toBe(6_000);
    await don(a.id, 9_999, "pending");
    expect(await getUnallocated(a.id)).toBe(6_000);
  });
});

describe("rendered public HTML", () => {
  it("cat card and detail HTML contain no private data", async () => {
    const { cat } = await seed();
    const card = await getCatCard(cat.id);
    const html =
      renderToStaticMarkup(createElement(CatRow, { cat: card!.cat })) +
      renderToStaticMarkup(createElement(CatDetail, { card: card!, judge: true }));
    expectClean(html);
    expect(html).toContain("Brgy. San Antonio, near the market");
    expect(html).toMatch(/exact spot kept private/i);
    expect(html).toMatch(/do not post/i);
    expect(html).not.toContain("—");
    const list = await listCats("all");
    expectClean(JSON.stringify(list));
  });
});

describe("the priority list", () => {
  const NOW = new Date("2026-11-03T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  let n = 0;
  async function cat(name: string, over: Partial<typeof cats.$inferInsert> = {}) {
    const [c] = await db
      .insert(cats)
      .values({ name, sex: "male", areaName: "Brgy 1", status: "queued", queuedAt: daysAgo(10 - ++n), ...over })
      .returning();
    return c;
  }
  async function report(catId: string, over: Partial<typeof reports.$inferInsert> = {}) {
    const [r] = await db
      .insert(reports)
      .values({ catId, claim: "injured", source: "neighbour", status: "open", reportedOn: "2026-11-03", ...over })
      .returning();
    return r;
  }
  const pool = (net: number) => db.insert(donations).values({ gross: net, net, paypalOrderId: `p-${++n}`, status: "captured" });
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);

  it("puts held cats in Needs a person first and queued cats in Next to fund, and leaves funded cats out", async () => {
    const hurt = await cat("Bituin");
    const spotted = await cat("Nami", { status: "spotted", queuedAt: null });
    const funded = await cat("Ghost", { status: "funded" });
    await cat("Mocha");
    await cat("Pogi");
    await report(hurt.id);
    await report(spotted.id, { claim: "sick" });
    await report(funded.id);
    const list = await getPriorityList(NOW);
    expect(names(list.needsPerson).sort()).toEqual(["Bituin", "Nami"]);
    expect(names(list.nextToFund)).toEqual(["Mocha", "Pogi"]);
    expect(list.nextToFund.map((r) => r.position)).toEqual([1, 2]);
    expect(list.needsPerson.every((r) => r.position === null)).toBe(true);
  });

  it("uses the fixed labels and the claim words", async () => {
    const a = await cat("A1");
    const b = await cat("B1");
    const c = await cat("C1");
    const d = await cat("D1");
    const e = await cat("E1");
    await report(a.id);
    await report(b.id, { source: "photo", claim: "injured" });
    await report(c.id, { status: "confirmed", source: "caretaker", claim: "sick" });
    await report(d.id, { claim: "pregnant" });
    await report(e.id, { status: "cleared", source: "vet", claim: "injured" });
    const list = await getPriorityList(NOW);
    const by = (nm: string) => [...list.needsPerson, ...list.nextToFund].find((r) => r.name === nm)!;
    expect(by("A1").labels).toEqual(["Neighbour says hurt"]);
    expect(by("B1").labels).toEqual(["Photo suggests hurt"]);
    expect(by("C1").labels).toEqual(["Sick", "Caretaker confirmed"]);
    expect(by("D1").labels).toEqual(["Neighbour says pregnant"]);
    expect(by("E1").labels).toEqual(["Vet ready"]);
    expect(list.nextToFund.map((r) => r.name)).toEqual(["E1"]);
  });

  it("never carries a note, a reporter, a place or a key, in the data, the page or the API", async () => {
    const [reporter] = await db.insert(users).values({ username: "finder_one", role: "donor" }).returning();
    const c = await cat("Bituin", { exactLat: EXACT_LAT, exactLng: EXACT_LNG });
    await report(c.id, { note: "Call me on 0917 123 4567, behind the Shell on Rizal St", reporterId: reporter.id });
    await db.insert(sightings).values({ catId: c.id, originalKey: ORIGINAL_KEY, publicKey: null, publicReady: false, state: "matched" });
    const list = await getPriorityList(NOW);
    const res = await priorityGet();
    const html = renderToStaticMarkup(createElement(PriorityList, { initial: list }));
    for (const text of [JSON.stringify(list), await res.text(), html]) {
      expectClean(text);
      for (const s of ["0917", "Shell", "Rizal", "finder_one", reporter.id]) expect(text).not.toContain(s);
    }
    expect(Object.keys(list.needsPerson[0]).sort()).toEqual(["catId", "fundNote", "labels", "name", "photoUrl", "position", "reason"]);
  });

  it("API returns the same rows as the page", async () => {
    await cat("Mocha");
    const list = await getPriorityList(NOW);
    const body = await (await priorityGet()).json();
    expect(Object.keys(body).sort()).toEqual(["needsPerson", "nextToFund"]);
    expect(body.nextToFund.map((r: { name: string }) => r.name)).toEqual(list.nextToFund.map((r) => r.name));
  });

  it("gives each row the right reason, and a fallback when the reason is unsafe", async () => {
    const old = await cat("Mocha", { queuedAt: daysAgo(20) });
    const kitten = await cat("Pogi", { queuedAt: daysAgo(2) });
    const held = await cat("Bituin");
    const bare = await cat("Nami");
    const heldReport = await report(held.id);
    await report(bare.id, { claim: "sick" });
    const checked = await report(kitten.id, { claim: "kitten", status: "confirmed", source: "caretaker" });
    await db.transaction((tx) =>
      placeCat(tx, { catId: kitten.id, beforeCatId: old.id, reason: "Pogi is a confirmed kitten, so he goes ahead of Mocha.", reportId: checked.id }, NOW),
    );
    await db.insert(agentActions).values({
      action: "ask_for_check",
      reason: "Bituin may be limping, so a caretaker should look.",
      status: "done",
      inputs: { catId: held.id, reportId: heldReport.id, claim: "injured" },
    });
    const list = await getPriorityList(NOW);
    const by = (nm: string) => [...list.needsPerson, ...list.nextToFund].find((r) => r.name === nm)!;
    expect(names(list.nextToFund)).toEqual(["Pogi", "Mocha"]);
    expect(by("Pogi").reason).toBe("Pogi is a confirmed kitten, so he goes ahead of Mocha.");
    expect(by("Mocha").reason).toMatch(/waits by time in the queue/);
    expect(by("Bituin").reason).toBe("Bituin may be limping, so a caretaker should look.");
    expect(by("Nami").reason).toBe("A person needs to check this first.");

    await db.update(agentActions).set({ reason: "Bituin is limping near 0917 123 4567" }).where(eq(agentActions.action, "ask_for_check"));
    await db.update(agentActions).set({ reason: "Pogi goes first, he sleeps at 12 Rizal Street" }).where(eq(agentActions.action, "set_cat_place"));
    const safe = await getPriorityList(NOW);
    const by2 = (nm: string) => [...safe.needsPerson, ...safe.nextToFund].find((r) => r.name === nm)!;
    expect(by2("Bituin").reason).toBe("The Treasurer asked a caretaker to look at a cat.");
    expect(by2("Pogi").reason).toBe("The Treasurer changed the order after a check.");
  });

  it("does not show an old question when a new report holds the cat again", async () => {
    const c = await cat("Bituin");
    const old = await report(c.id, { status: "cleared", source: "vet" });
    await db.insert(agentActions).values({
      action: "ask_for_check",
      reason: "Bituin may be limping, so a caretaker should look.",
      status: "done",
      inputs: { catId: c.id, reportId: old.id, claim: "injured" },
    });
    await report(c.id, { claim: "sick" });
    const row = (await getPriorityList(NOW)).needsPerson[0];
    expect(row.reason).toBe("A person needs to check this first.");
    expect(row.labels).toEqual(["Neighbour says sick"]);
  });

  it("follows the report's state: an open report may show the Treasurer's question, a confirmed one waits for a vet", async () => {
    const c = await cat("Bituin");
    const r = await report(c.id);
    await db.insert(agentActions).values({
      action: "ask_for_check",
      reason: "Bituin may be limping, so a caretaker should look.",
      status: "done",
      inputs: { catId: c.id, reportId: r.id, claim: "injured" },
    });
    expect((await getPriorityList(NOW)).needsPerson[0].reason).toBe("Bituin may be limping, so a caretaker should look.");
    await db.update(reports).set({ status: "confirmed", source: "caretaker" }).where(eq(reports.id, r.id));
    const row = (await getPriorityList(NOW)).needsPerson[0];
    expect(row.reason).toBe("A caretaker confirmed this. A vet needs to check next.");
    expect(row.labels).toEqual(["Hurt", "Caretaker confirmed"]);
  });

  it("labels an open staff report by its source, and leaves a dismissed one out", async () => {
    const a = await cat("A2");
    const b = await cat("B2");
    await report(a.id, { source: "vet", status: "open" });
    await report(b.id, { status: "dismissed" });
    const list = await getPriorityList(NOW);
    expect(list.needsPerson.map((r) => [r.name, r.labels])).toEqual([["A2", ["Vet says hurt"]]]);
    expect(names(list.nextToFund)).toEqual(["B2"]);
    expect(list.nextToFund[0].labels).toEqual([]);
  });

  it("shows a held cat that is only spotted", async () => {
    const c = await cat("Nami", { status: "spotted", queuedAt: null });
    await report(c.id, { claim: "pregnant" });
    const list = await getPriorityList(NOW);
    expect(names(list.needsPerson)).toEqual(["Nami"]);
    expect(list.nextToFund).toEqual([]);
  });

  it("falls back to the rank reason when a move lapses with its report", async () => {
    const old = await cat("Mocha", { queuedAt: daysAgo(20) });
    const kitten = await cat("Pogi", { queuedAt: daysAgo(2) });
    const checked = await report(kitten.id, { claim: "kitten", status: "confirmed", source: "caretaker" });
    await db.transaction((tx) => placeCat(tx, { catId: kitten.id, beforeCatId: old.id, reason: "Pogi goes first.", reportId: checked.id }, NOW));
    expect((await getPriorityList(NOW)).nextToFund[0].reason).toBe("Pogi goes first.");
    await db.update(reports).set({ status: "dismissed" }).where(eq(reports.id, checked.id));
    const after = await getPriorityList(NOW);
    expect(names(after.nextToFund)).toEqual(["Mocha", "Pogi"]);
    expect(after.nextToFund[1].reason).toMatch(/waits by time in the queue/);
  });

  it("hides a reason that repeats a report note, on the page and in the feed", async () => {
    const c = await cat("Bituin");
    const noted = await report(c.id, { note: "She hides under the red car near the gate" });
    await db.insert(agentActions).values({
      action: "ask_for_check",
      reason: "Bituin hides under the red car, so a caretaker should look.",
      status: "done",
      inputs: { catId: c.id, reportId: noted.id },
    });
    const row = (await getPriorityList(NOW)).needsPerson[0];
    expect(row.reason).toBe("The Treasurer asked a caretaker to look at a cat.");
    expect((await listAgentActions())[0].reason).toBe("The Treasurer asked a caretaker to look at a cat.");
    await db.update(agentActions).set({ reason: "Bituin was by the red car, so a caretaker should look." });
    expect((await getPriorityList(NOW)).needsPerson[0].reason).toBe("Bituin was by the red car, so a caretaker should look.");
  });

  it("noteEchoes needs four words in a row", () => {
    const note = "She hides under the red car near the gate!";
    const grams = noteGramsOf([note]);
    expect(noteEchoes("It hides under the red car.", grams)).toBe(true);
    expect(noteEchoes("HIDES, under the RED car", grams)).toBe(true);
    expect(noteEchoes("She is near the red car", grams)).toBe(false);
    expect(noteEchoes("Under the red car is a hint", grams)).toBe(true);
    expect(noteEchoes("under the red", grams)).toBe(false);
    expect(noteEchoes("anything at all here", noteGramsOf([]))).toBe(false);
  });

  it("noteGramsOf is built once and holds only four-word groups, so a short note adds nothing", () => {
    const grams = noteGramsOf(["Hides under the red car!", "too short"]);
    expect([...grams].sort()).toEqual(["hides under the red", "under the red car"]);
    expect(noteEchoes("a b hides under the red", grams)).toBe(true);
  });

  it("says what the fund can cover on the first cat only", async () => {
    await cat("Mocha");
    await cat("Pogi");
    const price = 150_000;
    await db.update(guardrails).set({ packagePrice: price });
    await pool(price - 30_000);
    const short = await getPriorityList(NOW);
    expect(short.nextToFund[0].fundNote).toBe("Needs ₱300 more in the fund.");
    expect(short.nextToFund[1].fundNote).toBeNull();
    await pool(30_000);
    expect((await getPriorityList(NOW)).nextToFund[0].fundNote).toBe("The fund covers this cat now.");
  });

  it("shows a public photo only, never an original", async () => {
    const a = await cat("Mocha");
    const b = await cat("Pogi");
    await db.insert(sightings).values([
      { catId: a.id, originalKey: ORIGINAL_KEY, publicKey: PUBLIC_KEY, publicReady: true, state: "matched" },
      { catId: b.id, originalKey: ORIGINAL_KEY, publicKey: PUBLIC_KEY, publicReady: false, state: "matched" },
    ]);
    const list = await getPriorityList(NOW);
    const by = (nm: string) => list.nextToFund.find((r) => r.name === nm)!;
    expect(by("Mocha").photoUrl).toContain(PUBLIC_KEY);
    expect(by("Pogi").photoUrl).toBeNull();
  });

  it("renders both groups, and an empty list in words", async () => {
    const h = await cat("Bituin");
    await report(h.id);
    await cat("Mocha");
    const html = renderToStaticMarkup(createElement(PriorityList, { initial: await getPriorityList(NOW) }));
    expect(html).toContain("Needs a person first");
    expect(html).toContain("Next to fund");
    expect(html).toContain(`href="/cats/${h.id}"`);
    expect(html).not.toContain("—");
    const empty = renderToStaticMarkup(createElement(PriorityList, { initial: { needsPerson: [], nextToFund: [] } }));
    expect(empty).toContain("No cats need funding or a check right now.");
  });
});
