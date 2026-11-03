import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { bookings, cats, sightings, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { gpsJpeg } from "./helpers/images";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}));

import { GET as catGet } from "../src/app/api/cats/[id]/route";
import { GET as imageGet } from "../src/app/api/caretaker/images/[kind]/[id]/route";
import { COLONY } from "../src/lib/config";
import { getCaretakerQueue, getRulesView } from "../src/server/caretaker/queue";
import { getCatForViewer } from "../src/server/public";
import { SESSION_COOKIE, signSession, switchPersona, type PersonaKey } from "../src/server/session";
import { storeOriginal, publishScrubbed } from "../src/server/photos";
import { getVetBooking, listVetDashboard } from "../src/server/vetFlow";
import { maskEmail } from "../src/server/demoPrivacy";

const LAT = 10.987654321;
const LNG = 120.123456789;
const REAL_EMAIL = "real.vet.sentinel@clinic.example.test";
const HIDDEN_BIO = "Waits outside the Mercury Drug on Rizal Ave 12.";

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("PAYPAL_VET_EMAIL", REAL_EMAIL);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

async function world() {
  const [cat] = await db
    .insert(cats)
    .values({ name: "Muning", areaName: COLONY.area_name, status: "funded", exactLat: LAT, exactLng: LNG, fuzzedLat: 10.5, fuzzedLng: 120.5 })
    .returning();
  const [undecided] = await db
    .insert(cats)
    .values({ name: "Undecided", areaName: COLONY.area_name, status: "spotted", exactLat: LAT, exactLng: LNG })
    .returning();
  const original = await storeOriginal(await gpsJpeg());
  const [held] = await db
    .insert(sightings)
    .values({ catId: cat.id, originalKey: original.key, state: "new_cat", exactLat: LAT, exactLng: LNG })
    .returning();
  const [waiting] = await db
    .insert(sightings)
    .values({
      originalKey: (await storeOriginal(await gpsJpeg())).key,
      state: "needs_review",
      exactLat: LAT,
      exactLng: LNG,
      assessment: {
        is_cat: true, cat_visible_quality: "good", reject_reason: "none", coat_pattern: "tabby", colors: ["orange"], markings: "socks",
        flags: { kitten: false, pregnant: false, injured: false, sick: false }, probably_female_by_coat: false,
        suggested_name: "Muning", short_bio: HIDDEN_BIO, sensitive_regions: [], no_sensitive_content: true,
        review_reason: "ai_unusable", candidate_cat_ids: [],
      },
    })
    .returning();
  return { cat, undecided, held, waiting, original };
}

async function asPersona(key: PersonaKey) {
  const s = await switchPersona(key);
  jar.set(SESSION_COOKIE, await signSession(s));
  return s;
}

const COORDS = [String(LAT), String(LNG), "10.98765", "120.12345"];
const noCoords = (v: unknown) => {
  const text = JSON.stringify(v);
  for (const c of COORDS) expect(text, `leaked ${c}`).not.toContain(c);
};

describe("maskEmail", () => {
  it("keeps one letter on each side and the end of the domain", () => {
    expect(maskEmail("real.vet@clinic.example.test")).toBe("r***@c***.test");
    expect(maskEmail("a@b.co")).toBe("a***@b***.co");
    expect(maskEmail("not an email")).toBe("***");
    expect(maskEmail(null)).toBeNull();
  });
});

describe("I1: DEMO_MODE on, as the demo caretaker", () => {
  it("the desk queue carries the area name, no coordinates, and no model text about places", async () => {
    await world();
    await asPersona("caretaker");
    const q = await getCaretakerQueue();
    noCoords(q);
    expect(q.sightings[0]).toMatchObject({ exact: null, area: COLONY.area_name, exactHidden: true });
    expect(q.earTipPending[0]).toMatchObject({ exact: null, area: COLONY.area_name, exactHidden: true });
    expect(JSON.stringify(q)).not.toContain("Mercury");
  });

  it("the rules page masks the vet's PayPal email", async () => {
    await asPersona("caretaker");
    const rules = await getRulesView();
    const vet = rules.vets.find((v) => v.username === "demo_vet")!;
    expect(vet.paypalEmail).toBe(maskEmail(REAL_EMAIL));
    expect(vet.emailHidden).toBe(true);
    expect(JSON.stringify(rules)).not.toContain("real.vet.sentinel");
  });

  it("the cat API gives no exact location, to either staff persona", async () => {
    const { cat } = await world();
    for (const key of ["caretaker", "vet"] as const) {
      await asPersona(key);
      const view = await getCatForViewer(cat.id, await switchPersona(key));
      expect(view).not.toHaveProperty("exact");
      const res = await catGet(new Request("http://x"), { params: Promise.resolve({ id: cat.id }) });
      noCoords(await res.json());
    }
  });

  it("a sighting original is never served: the public copy is, or a plain 'Hidden in the demo' picture", async () => {
    const { held, waiting, original } = await world();
    await asPersona("caretaker");
    const get = (id: string) => imageGet(new Request("http://x"), { params: Promise.resolve({ kind: "sighting", id }) });

    const hidden = await get(waiting.id);
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("content-type")).toBe("image/svg+xml");
    expect(await hidden.text()).toContain("Hidden in the demo");

    const { key } = await publishScrubbed(original.key, []);
    await db.update(sightings).set({ publicKey: key, publicReady: true }).where(eq(sightings.id, held.id));
    const pub = await get(held.id);
    expect(pub.status).toBe(302);
    expect(pub.headers.get("location")).toContain(key);
  });
});

describe("I1: DEMO_MODE on, as the demo vet", () => {
  it("the dashboard and a booking carry the area name, not coordinates", async () => {
    const { cat } = await world();
    const vet = await asPersona("vet");
    const [booking] = await db
      .insert(bookings)
      .values({ catId: cat.id, vetId: vet.userId, packagePrice: 150000, status: "confirmed", scheduledFor: new Date() })
      .returning();
    const dash = await listVetDashboard(vet.userId);
    noCoords(dash);
    expect(dash.fundedCats[0]).toMatchObject({ exact: null, area: COLONY.area_name, exactHidden: true });
    expect(dash.bookings[0]).toMatchObject({ exact: null, area: COLONY.area_name, exactHidden: true });
    const view = await getVetBooking(vet.userId, booking.id);
    noCoords(view);
  });
});

describe("I1: DEMO_MODE off, real staff see what they need", () => {
  beforeEach(() => vi.stubEnv("DEMO_MODE", "false"));

  async function staff(role: "caretaker" | "vet") {
    const [u] = await db.insert(users).values({ username: `real_${role}`, role, paypalEmail: role === "vet" ? REAL_EMAIL : null }).returning();
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role, username: u.username }));
    return u;
  }

  it("the desk shows exact places and the unmasked email", async () => {
    await world();
    await staff("caretaker");
    const q = await getCaretakerQueue();
    expect(q.sightings[0].exact).toMatchObject({ lat: LAT, lng: LNG });
    expect(q.sightings[0].exactHidden).toBe(false);
    expect(q.earTipPending[0].exact).toMatchObject({ lat: LAT, lng: LNG });
    expect(JSON.stringify(q)).toContain("Mercury");
    await db.insert(users).values({ username: "a_vet", role: "vet", paypalEmail: REAL_EMAIL });
    expect((await getRulesView()).vets[0].paypalEmail).toBe(REAL_EMAIL);
  });

  it("the cat API gives exact to staff, and the original is served to the caretaker", async () => {
    const { cat, waiting } = await world();
    const u = await staff("caretaker");
    const view = await getCatForViewer(cat.id, { userId: u.id, username: u.username, role: "caretaker" });
    expect(view!.exact).toMatchObject({ lat: LAT, lng: LNG });
    const res = await imageGet(new Request("http://x"), { params: Promise.resolve({ kind: "sighting", id: waiting.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("the vet sees exact places", async () => {
    const { cat } = await world();
    const vet = await staff("vet");
    const [booking] = await db.insert(bookings).values({ catId: cat.id, vetId: vet.id, packagePrice: 150000, status: "confirmed", scheduledFor: new Date() }).returning();
    const dash = await listVetDashboard(vet.id);
    expect(dash.fundedCats[0].exact).toMatchObject({ lat: LAT, lng: LNG });
    expect(dash.bookings[0]).toMatchObject({ exactHidden: false });
    expect((await getVetBooking(vet.id, booking.id))!.booking.exact).toMatchObject({ lat: LAT });
  });
});
