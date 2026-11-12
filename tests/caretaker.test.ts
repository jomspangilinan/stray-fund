import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { closePool, db } from "../src/server/db/client";
import {
  agentActions,
  allocations,
  allowedPayees,
  bookings,
  cats,
  earTipFlags,
  nameSuggestions,
  guardrails,
  payouts,
  receipts,
  reports,
  reviewRequests,
  sightings,
  treatments,
  users,
  wakeups,
} from "../src/server/db/schema";
import { fileReview } from "../src/server/agent/review";
import { clearCatForSurgery, fileReport, heldCatIds } from "../src/server/reports";
import { requestPayout } from "../src/server/moneyGate";
import { storeOriginal } from "../src/server/photos";
import { checkerImage, greyRegion, variance } from "./helpers/images";
import { getCatCard, getYard, listAgentActions, manilaDate } from "../src/server/public";
import { SESSION_COOKIE, signSession, type Role } from "../src/server/session";
import { getStorage, newPublicKey } from "../src/server/storage";
import { setCatFinderForTests } from "../src/server/catFinder";
import { developNext } from "../src/server/develop";
import { assertCanSubmitEvidence } from "../src/server/vetFlow";
import { truncateAll } from "./helpers/db";
import { FakeGateway, addPayout, fundCat, makeBooking, makeCaretaker, makeVet, makeWorld } from "./helpers/payoutFixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { ACTION_NAMES, setGatewayForTests } from "../src/server/caretaker";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { POST } from "../src/app/api/caretaker/[action]/route";
import { GET as imageGet } from "../src/app/api/caretaker/images/[kind]/[id]/route";

let seq = 0;
let shade = 20;
async function image(): Promise<Buffer> {
  shade += 3;
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: shade % 255, g: 90, b: (shade * 7) % 255 } } })
    .jpeg()
    .toBuffer();
}

async function signIn(u: { id: string; username: string }, role: Role) {
  jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role, username: u.username }));
}

type Reply = { status: number; message: string; ok: boolean };
async function act(action: string, body: unknown = {}): Promise<Reply> {
  const res = await POST(
    new Request(`http://x/api/caretaker/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ action }) },
  );
  const json = (await res.json()) as { ok: boolean; message: string };
  return { status: res.status, message: json.message, ok: json.ok };
}

let caretaker: Awaited<ReturnType<typeof makeCaretaker>>;
let gateway: FakeGateway;

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  caretaker = await makeCaretaker();
  await signIn(caretaker, "caretaker");
  gateway = new FakeGateway();
  setGatewayForTests(gateway);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setGatewayForTests(null);
});
afterAll(closePool);

const wakeupKinds = async () => (await db.select().from(wakeups)).map((w) => w.kind);
const catRow = async (id: string) => (await db.select().from(cats).where(eq(cats.id, id)))[0];
const limits = async () => (await db.select().from(guardrails))[0];
const actionsNamed = (action: string) => db.select().from(agentActions).where(eq(agentActions.action, action));

// ---------- Who may act ----------

describe("role checks", () => {
  it("every action is 401 signed out and 403 for donors and vets", async () => {
    expect(ACTION_NAMES.length).toBeGreaterThan(20);
    const donor = (await db.insert(users).values({ username: "donor1", role: "donor" }).returning())[0];
    const vet = await makeVet();
    for (const name of ACTION_NAMES) {
      jar.clear();
      expect((await act(name, {})).status, `${name} signed out`).toBe(401);
      await signIn(donor, "donor");
      expect((await act(name, {})).status, `${name} donor`).toBe(403);
      await signIn(vet, "vet");
      expect((await act(name, {})).status, `${name} vet`).toBe(403);
    }
  });

  it("a caretaker with an empty body gets a plain 400, never a 500", async () => {
    for (const name of ACTION_NAMES) {
      const r = await act(name, {});
      expect(r.status, `${name}: ${r.message}`).toBeGreaterThanOrEqual(400);
      expect(r.status, name).toBeLessThan(500);
      expect(r.ok).toBe(false);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("refuses a body that is not JSON and an unknown action", async () => {
    const res = await POST(
      new Request("http://x/api/caretaker/guardrails_update", { method: "POST", headers: { "content-type": "text/plain" }, body: "a=b" }),
      { params: Promise.resolve({ action: "guardrails_update" }) },
    );
    expect(res.status).toBe(415);
    expect((await act("no_such_action")).status).toBe(404);
  });
});

// ---------- Guardrails ----------

const rules = (over: Record<string, unknown> = {}) => ({
  packagePrice: "1500",
  depositPct: "30",
  maxPerCat: "2500",
  maxPerDay: "10000",
  approvalThreshold: "2000",
  matchConfidenceMin: "0.8",
  ...over,
});

describe("guardrail edits validate", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["a negative cap", { maxPerCat: "-5" }],
    ["a percent over 100", { depositPct: "101" }],
    ["a percent of 0", { depositPct: "0" }],
    ["a threshold above the per-cat cap", { approvalThreshold: "2600" }],
    ["a per-day cap below the per-cat cap", { maxPerDay: "2000" }],
    ["a package price above the per-cat cap", { packagePrice: "2600" }],
    ["a fractional peso amount", { maxPerCat: "2500.5" }],
    ["a confidence above 1", { matchConfidenceMin: "1.5" }],
    ["a negative confidence", { matchConfidenceMin: "-0.1" }],
    ["text", { packagePrice: "lots" }],
    ["a missing field", { depositPct: undefined }],
  ];
  for (const [name, over] of bad) {
    it(`rejects ${name} and changes nothing`, async () => {
      const before = await limits();
      const r = await act("guardrails_update", rules(over));
      expect(r.status).toBe(400);
      expect(await limits()).toEqual(before);
      expect(await actionsNamed("guardrails_changed")).toHaveLength(0);
    });
  }

  it("stores integer pesos as centavos and writes an audit row with old and new values", async () => {
    const r = await act("guardrails_update", rules({ maxPerCat: "3000", maxPerDay: "12000", depositPct: "40", matchConfidenceMin: "0.9" }));
    expect(r.status).toBe(200);
    const row = await limits();
    expect(row.maxPerCat).toBe(300000);
    expect(row.maxPerDay).toBe(1200000);
    expect(row.depositPct).toBe(40);
    expect(row.matchConfidenceMin).toBe(0.9);
    expect(row).not.toHaveProperty("earTipConfidenceMin");
    const [audit] = await actionsNamed("guardrails_changed");
    expect(audit.approvedBy).toBe(caretaker.id);
    const inputs = audit.inputs as { old: Record<string, number>; new: Record<string, number> };
    expect(inputs.old.maxPerCat).toBe(250000);
    expect(inputs.new.maxPerCat).toBe(300000);
    expect(inputs.old.depositPct).toBe(30);
    expect(inputs.new.depositPct).toBe(40);
  });

  it("an unchanged form writes no audit row", async () => {
    const r = await act("guardrails_update", rules());
    expect(r.status).toBe(200);
    expect(await actionsNamed("guardrails_changed")).toHaveLength(0);
  });
});

describe("lowered cap applies to pending approval on approve", () => {
  it("approve re-runs the guardrails against the new cap and does not pay", async () => {
    const w = await makeWorld({ funded: 250000 });
    const p = await addPayout(w, { amount: 120000, status: "awaiting_approval" });
    expect((await act("guardrails_update", rules({ packagePrice: "1000", maxPerCat: "1000", maxPerDay: "10000", approvalThreshold: "1000" }))).status).toBe(200);

    const r = await act("payout_approve", { payoutId: p.id });
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/cap/i);
    expect(r.message).toMatch(/still waiting for approval/);
    expect(gateway.calls).toHaveLength(0);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, p.id));
    expect(row.status).toBe("awaiting_approval");
  });
});

describe("allowed payees", () => {
  it("removing a payee denies a live booking's approve and leaves paid payouts alone", async () => {
    const w = await makeWorld({ funded: 250000 });
    const paid = await addPayout(w, { amount: 45000, status: "succeeded", batchId: "done-1" });
    const w2 = { ...w, booking: await makeBooking((await db.insert(cats).values({ name: "Other", areaName: "x" }).returning())[0].id, w.vet.id) };
    await fundCat(w2.booking.catId, 100000);
    const waiting = await addPayout({ cat: { id: w2.booking.catId }, vet: w.vet, booking: w2.booking } as never, { amount: 30000, status: "awaiting_approval" });

    expect((await act("payee_remove", { userId: w.vet.id })).status).toBe(200);
    expect(await db.select().from(allowedPayees).where(eq(allowedPayees.userId, w.vet.id))).toHaveLength(0);
    const [still] = await db.select().from(payouts).where(eq(payouts.id, paid.id));
    expect(still.status).toBe("succeeded");

    const r = await act("payout_approve", { payoutId: waiting.id });
    expect(r.status).toBe(409);
    expect(gateway.calls).toHaveLength(0);
    expect((await actionsNamed("payee_removed"))[0].approvedBy).toBe(caretaker.id);
  });

  it("adds a vet by username, once, and refuses anyone who is not a vet", async () => {
    const vet = await makeVet({ allowed: false });
    expect((await act("payee_add", { username: vet.username })).status).toBe(200);
    expect((await act("payee_add", { username: vet.username.toUpperCase() })).status).toBe(200);
    expect(await db.select().from(allowedPayees).where(eq(allowedPayees.userId, vet.id))).toHaveLength(1);
    expect(await actionsNamed("payee_added")).toHaveLength(1);

    await db.insert(users).values({ username: "plain_donor", role: "donor" });
    expect((await act("payee_add", { username: "plain_donor" })).status).toBe(400);
    expect((await act("payee_add", { username: "nobody_here" })).status).toBe(404);
  });

  it("edits a vet's clinic name and PayPal email with validation, and keeps the email out of the audit row", async () => {
    const vet = await makeVet();
    expect((await act("vet_update", { userId: vet.id, clinicName: "Happy Paws Clinic", paypalEmail: "not-an-email" })).status).toBe(400);
    expect((await act("vet_update", { userId: vet.id, clinicName: "", paypalEmail: "ok@example.test" })).status).toBe(400);
    expect((await act("vet_update", { userId: vet.id, clinicName: "Happy <b>Paws", paypalEmail: "ok@example.test" })).status).toBe(400);
    expect((await act("vet_update", { userId: vet.id, clinicName: "Happy Paws Clinic", paypalEmail: "New.Vet@Example.test" })).status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, vet.id));
    expect(row.clinicName).toBe("Happy Paws Clinic");
    expect(row.paypalEmail).toBe("new.vet@example.test");
    const audit = JSON.stringify(await actionsNamed("vet_details_changed"));
    expect(audit).not.toMatch(/example\.test/);
    const donor = (await db.insert(users).values({ username: "d2", role: "donor" }).returning())[0];
    expect((await act("vet_update", { userId: donor.id, clinicName: "X Clinic", paypalEmail: "a@example.test" })).status).toBe(400);
  });
});

// ---------- Payouts ----------

describe("payouts", () => {
  it("approve sends once, records the caretaker, and a double click does not send twice", async () => {
    const w = await makeWorld({ funded: 250000 });
    const p = await addPayout(w, { amount: 45000, status: "awaiting_approval" });
    const [a, b] = await Promise.all([act("payout_approve", { payoutId: p.id }), act("payout_approve", { payoutId: p.id })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(gateway.calls).toHaveLength(1);
    const [action] = await db.select().from(agentActions).where(eq(agentActions.id, p.actionId));
    expect(action.approvedBy).toBe(caretaker.id);
  });

  it("reject frees the reservation and needs a reason", async () => {
    const w = await makeWorld();
    const p = await addPayout(w, { amount: 45000, status: "awaiting_approval" });
    expect((await act("payout_reject", { payoutId: p.id })).status).toBe(400);
    expect((await act("payout_reject", { payoutId: p.id, reason: "Not this week" })).status).toBe(200);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, p.id));
    expect(row.status).toBe("rejected");
    expect(gateway.calls).toHaveLength(0);
  });

  it("a needs_review payout: paid needs a reference, not_paid needs a note", async () => {
    const w = await makeWorld();
    const p = await addPayout(w, { amount: 45000, status: "needs_review" });
    expect((await act("payout_resolve", { payoutId: p.id, outcome: "paid" })).status).toBe(400);
    expect((await act("payout_resolve", { payoutId: p.id, outcome: "not_paid" })).status).toBe(400);
    expect((await act("payout_resolve", { payoutId: p.id, outcome: "maybe", note: "x" })).status).toBe(400);
    expect((await act("payout_resolve", { payoutId: p.id, outcome: "not_paid", note: "Checked PayPal activity, nothing left" })).status).toBe(200);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, p.id));
    expect(row.status).toBe("failed");
  });

  it("shows the gate's refusal plainly when the batch may exist at PayPal", async () => {
    const w = await makeWorld();
    const p = await addPayout(w, { amount: 45000, status: "needs_review", batchId: "BATCH-123" });
    const r = await act("payout_resolve", { payoutId: p.id, outcome: "not_paid", note: "I think it did not go" });
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/PayPal batch/);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, p.id));
    expect(row.status).toBe("needs_review");
  });

  it("records a paid ruling with the reference", async () => {
    const w = await makeWorld();
    const p = await addPayout(w, { amount: 45000, status: "needs_review" });
    expect((await act("payout_resolve", { payoutId: p.id, outcome: "paid", paypalRef: "PAYPAL-REF-9" })).status).toBe(200);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, p.id));
    expect(row.status).toBe("succeeded");
    expect(row.paypalPayoutBatchId).toBe("PAYPAL-REF-9");
  });

  it("a note on a long-sent payout writes an audit row and moves nothing", async () => {
    const w = await makeWorld();
    const p = await addPayout(w, { amount: 45000, status: "sent", batchId: "B-1" });
    expect((await act("payout_note", { payoutId: p.id })).status).toBe(400);
    expect((await act("payout_note", { payoutId: p.id, note: "Asked the vet to check their inbox" })).status).toBe(200);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, p.id));
    expect(row.status).toBe("sent");
    expect(await actionsNamed("payout_note")).toHaveLength(1);
  });
});

// ---------- Evidence ----------

const GOOD_PARSED = {
  clinic: "Happy Paws Veterinary Clinic",
  date: "2026-11-02",
  total_centavos: 120000,
  currency: "PHP",
  receipt_number: "OR-77",
  cat_name: null,
  items: ["Spay surgery", "Anti-rabies vaccine", "Deworming tablet"],
  tamper_signs: [],
};

async function evidenceWorld(parsed: unknown = GOOD_PARSED) {
  const vet = await makeVet();
  await db.update(users).set({ clinicName: "Happy Paws Veterinary Clinic" }).where(eq(users.id, vet.id));
  const [cat] = await db
    .insert(cats)
    .values({ name: `Cat${++seq}`, areaName: "Brgy 1", status: "in_care", exactLat: 10.1, exactLng: 120.1 })
    .returning();
  await fundCat(cat.id, 150000);
  const [booking] = await db
    .insert(bookings)
    .values({ catId: cat.id, vetId: vet.id, packagePrice: 150000, status: "confirmed", scheduledFor: new Date(`${manilaDate(new Date())}T00:00:00+08:00`) })
    .returning();
  await addPayout({ cat, vet, booking }, { amount: 45000, status: "succeeded", batchId: `dep-${++seq}` });
  const { key: fileKey } = await storeOriginal(await image());
  const { key: earKey } = await storeOriginal(await image());
  const [receipt] = await db
    .insert(receipts)
    .values({
      bookingId: booking.id,
      fileKey,
      sha256: `sha-${++seq}`,
      parsed: parsed as object,
      earTipPhotoKey: earKey,
      verification: "needs_review",
      reasons: ["clinic_mismatch"],
    })
    .returning();
  await db.transaction((tx) => fileReview(tx, `Evidence on booking ${booking.id} needs a person`, "A vet's evidence could not be confirmed."));
  return { vet, cat, booking, receipt };
}

describe("accept evidence", () => {
  const accept = (receiptId: string, over: Record<string, unknown> = {}) =>
    act("evidence_accept", { receiptId, total: "1200", earTipConfirmed: true, note: "Looked at both photos, ear is tipped", ...over });

  it("refuses with 409 when the ear-tip photo is missing or was never stored, changing nothing", async () => {
    for (const key of ["originals/00000000-0000-4000-8000-00000000dead.jpg", null]) {
      const w = await evidenceWorld();
      await db.update(receipts).set({ earTipPhotoKey: key }).where(eq(receipts.id, w.receipt.id));
      expect(await accept(w.receipt.id)).toMatchObject({ ok: false, status: 409 });
      expect((await db.select().from(receipts).where(eq(receipts.id, w.receipt.id)))[0].verification).toBe("needs_review");
      expect(await db.select().from(treatments).where(eq(treatments.catId, w.cat.id))).toHaveLength(0);
      expect((await db.select().from(cats).where(eq(cats.id, w.cat.id)))[0].status).toBe("in_care");
      expect(await actionsNamed("evidence_accepted")).toHaveLength(0);
    }
  });

  it("refuses without the ear-tip tick, without a note, and for bad amounts, changing nothing", async () => {
    const w = await evidenceWorld();
    for (const over of [
      { earTipConfirmed: false },
      { earTipConfirmed: undefined },
      { note: "  " },
      { total: "" },
      { total: "450" },
      { total: "100" },
      { total: "1501" },
      { total: "abc" },
    ]) {
      const r = await accept(w.receipt.id, over);
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    const [row] = await db.select().from(receipts).where(eq(receipts.id, w.receipt.id));
    expect(row.verification).toBe("needs_review");
    expect((await catRow(w.cat.id)).status).toBe("in_care");
    expect((await catRow(w.cat.id)).earTipped).toBeNull();
    expect(await db.select().from(treatments)).toHaveLength(0);
  });

  it("is a real override: same outcome as verified, with the confirmed total, a note, and the caretaker on the audit row", async () => {
    const w = await evidenceWorld({ ...GOOD_PARSED, total_centavos: 119999, date: "gibberish" });
    const r = await accept(w.receipt.id);
    expect(r.status).toBe(200);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, w.receipt.id));
    expect(row.verification).toBe("verified");
    expect((row.parsed as { total_centavos: number }).total_centavos).toBe(120000);
    const cat = await catRow(w.cat.id);
    expect(cat.status).toBe("neutered");
    expect(cat.earTipped).toBe(true);
    expect((await db.select().from(treatments).where(eq(treatments.catId, w.cat.id))).map((t) => t.type).sort()).toEqual([
      "deworming",
      "neuter",
      "vaccine",
    ]);
    const net = (await db.select().from(allocations).where(eq(allocations.catId, w.cat.id))).reduce((s, a) => s + a.amount, 0);
    expect(net).toBe(120000);
    expect(await wakeupKinds()).toContain("evidence_ready");

    const [audit] = await actionsNamed("evidence_accepted");
    expect(audit.approvedBy).toBe(caretaker.id);
    const inputs = audit.inputs as { note: string; total: number; parsedTotal: number; earTipConfirmed: boolean };
    expect(inputs).toMatchObject({ note: "Looked at both photos, ear is tipped", total: 120000, parsedTotal: 119999, earTipConfirmed: true });

    const [review] = await db.select().from(reviewRequests);
    expect(review.status).toBe("resolved");
  });

  it("the gate then accepts the balance, and its ear-tip check still holds without the tick", async () => {
    const w = await evidenceWorld();
    expect((await accept(w.receipt.id)).status).toBe(200);
    const res = await requestPayout(
      { catId: w.cat.id, payeeId: w.vet.id, bookingId: w.booking.id, amount: 75000, kind: "balance", receiptId: w.receipt.id, reason: "r", inputs: {} },
      gateway,
    );
    expect(res.status).toBe("sent");

    const w2 = await evidenceWorld();
    await accept(w2.receipt.id, { earTipConfirmed: false });
    const denied = await requestPayout(
      { catId: w2.cat.id, payeeId: w2.vet.id, bookingId: w2.booking.id, amount: 75000, kind: "balance", receiptId: w2.receipt.id, reason: "r", inputs: {} },
      gateway,
    );
    expect(denied.status).toBe("rejected");
  });

  it("a second accept changes nothing", async () => {
    const w = await evidenceWorld();
    const [a, b] = await Promise.all([accept(w.receipt.id), accept(w.receipt.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.select().from(treatments).where(eq(treatments.catId, w.cat.id))).toHaveLength(3);
    expect(await actionsNamed("evidence_accepted")).toHaveLength(1);
  });

  it("works when nothing could be read from the receipt", async () => {
    const w = await evidenceWorld(null);
    expect((await accept(w.receipt.id)).status).toBe(200);
    expect((await catRow(w.cat.id)).status).toBe("neutered");
  });
});

describe("rejecting needs_review evidence leaves balance unpaid and notifies agent", () => {
  it("marks the receipt rejected, pays nothing, queues a wakeup and lets the vet resubmit", async () => {
    const w = await evidenceWorld();
    expect((await act("evidence_reject", { receiptId: w.receipt.id })).status).toBe(400);
    const r = await act("evidence_reject", { receiptId: w.receipt.id, note: "Photo does not show the ears" });
    expect(r.status).toBe(200);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, w.receipt.id));
    expect(row.verification).toBe("rejected");
    expect(row.reasons).toContain("caretaker_rejected");
    expect(await db.select().from(payouts).where(and(eq(payouts.bookingId, w.booking.id), eq(payouts.kind, "balance")))).toHaveLength(0);
    expect((await catRow(w.cat.id)).status).toBe("in_care");
    expect(await wakeupKinds()).toContain("evidence_rejected");
    expect((await actionsNamed("evidence_rejected"))[0].approvedBy).toBe(caretaker.id);
    await expect(assertCanSubmitEvidence(w.vet.id, w.booking.id)).resolves.toBeUndefined();

    expect((await act("evidence_reject", { receiptId: w.receipt.id, note: "again" })).status).toBe(409);
  });
});

// ---------- Private images ----------

describe("private evidence images", () => {
  const get = (kind: string, id: string) => imageGet(new Request(`http://x/api/caretaker/images/${kind}/${id}`), { params: Promise.resolve({ kind, id }) });

  it("streams the receipt and ear-tip images to a caretaker and to the booking's own vet only", async () => {
    vi.stubEnv("DEMO_MODE", "false"); // real staff get the real photo; the demo hides uploads (tests/demoPrivacy.test.ts)
    const w = await evidenceWorld();
    for (const kind of ["receipt", "eartip"]) {
      const res = await get(kind, w.receipt.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toMatch(/no-store|private/);
      expect(Buffer.from(await res.arrayBuffer()).length).toBeGreaterThan(100);
    }
    await signIn(w.vet, "vet");
    expect((await get("receipt", w.receipt.id)).status).toBe(200);

    await signIn(await makeVet(), "vet");
    expect((await get("receipt", w.receipt.id)).status).toBe(404);
    const donor = (await db.insert(users).values({ username: "d3", role: "donor" }).returning())[0];
    await signIn(donor, "donor");
    expect((await get("receipt", w.receipt.id)).status).toBe(404);
    jar.clear();
    expect((await get("receipt", w.receipt.id)).status).toBe(404);
  });

  it("404s for bad ids and kinds, and takes the key only from the database", async () => {
    const w = await evidenceWorld();
    expect((await get("receipt", "not-a-uuid")).status).toBe(404);
    expect((await get("receipt", "originals/x.jpg")).status).toBe(404);
    expect((await get("secret", w.receipt.id)).status).toBe(404);
    expect((await get("receipt", "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("serves sighting originals to caretakers only", async () => {
    const { key } = await storeOriginal(await image());
    const [s] = await db.insert(sightings).values({ originalKey: key, state: "needs_review" }).returning();
    expect((await get("sighting", s.id)).status).toBe(200);
    await signIn(await makeVet(), "vet");
    expect((await get("sighting", s.id)).status).toBe(404);
  });
});

// ---------- Review requests ----------

describe("agent review requests", () => {
  it("resolving closes the row, updates the feed status, enqueues a wakeup, and a new request can be filed again", async () => {
    const { id } = await db.transaction((tx) => fileReview(tx, "Payout abc needs a person", "Money may have left."));
    expect((await act("review_resolve", { reviewId: id })).status).toBe(400);
    const r = await act("review_resolve", { reviewId: id, resolution: "Checked PayPal, all fine SECRET-NOTE" });
    expect(r.status).toBe(200);

    const [row] = await db.select().from(reviewRequests).where(eq(reviewRequests.id, id));
    expect(row).toMatchObject({ status: "resolved", resolvedBy: caretaker.id, resolution: "Checked PayPal, all fine SECRET-NOTE" });
    expect(row.resolvedAt).not.toBeNull();
    const [action] = await actionsNamed("caretaker_review");
    expect(action.status).toBe("resolved");
    expect(await wakeupKinds()).toContain("review_resolved");

    const feed = await listAgentActions();
    expect(feed.find((f) => f.id === action.id)?.status).not.toMatch(/waiting/i);
    expect(JSON.stringify(feed)).not.toContain("SECRET-NOTE");

    expect((await act("review_resolve", { reviewId: id, resolution: "again" })).status).toBe(409);
    const again = await db.transaction((tx) => fileReview(tx, "payout ABC needs a person", "Again."));
    expect(again.deduplicated).toBe(false);
    const dup = await db.transaction((tx) => fileReview(tx, " Payout ABC needs a person ", "Again."));
    expect(dup.deduplicated).toBe(true);
  });
});

// ---------- Sightings ----------

const ASSESS = {
  is_cat: true,
  cat_visible_quality: "good",
  reject_reason: "none",
  coat_pattern: "tabby",
  colors: ["orange"],
  markings: "white socks",
  flags: { kitten: false, pregnant: true, injured: false, sick: false },
  probably_female_by_coat: true,
  suggested_name: "Muning",
  short_bio: "A calm orange cat.",
  no_sensitive_content: true,
  sensitive_regions: [] as unknown[],
};

async function reviewSighting(over: Partial<typeof sightings.$inferInsert> = {}) {
  const { key } = await storeOriginal(await image());
  const [s] = await db
    .insert(sightings)
    .values({ originalKey: key, state: "needs_review", exactLat: 10.2, exactLng: 120.6, assessment: { ...ASSESS, review_reason: "possible_match", candidate_cat_ids: [] }, ...over })
    .returning();
  return s;
}
const sightingRow = async (id: string) => (await db.select().from(sightings).where(eq(sightings.id, id)))[0];

describe("sighting review", () => {
  it("merging moves the sighting to the chosen cat without changing fuzz", async () => {
    const [cat] = await db
      .insert(cats)
      .values({ name: "Old cat", areaName: "x", exactLat: 10.2, exactLng: 120.6, fuzzedLat: 10.203, fuzzedLng: 120.603 })
      .returning();
    const s = await reviewSighting({ assessment: { ...ASSESS, review_reason: "possible_match", candidate_cat_ids: [cat.id] } });
    const r = await act("sighting_merge", { sightingId: s.id, catId: cat.id });
    expect(r.status).toBe(200);
    const row = await sightingRow(s.id);
    expect(row.catId).toBe(cat.id);
    expect(row.state).toBe("matched");
    const after = await catRow(cat.id);
    expect([after.fuzzedLat, after.fuzzedLng, after.exactLat, after.exactLng]).toEqual([10.203, 120.603, 10.2, 120.6]);
    expect(await db.select().from(cats)).toHaveLength(1);
    expect((await act("sighting_merge", { sightingId: s.id, catId: cat.id })).status).toBe(409);
    expect((await act("sighting_merge", { sightingId: s.id, catId: "00000000-0000-4000-8000-000000000000" })).status).toBe(409);
  });

  it("merging attaches the photo's report to the chosen cat and holds it", async () => {
    const cat = await makeCat("spotted");
    const s = await reviewSighting({ assessment: { ...ASSESS, review_reason: "possible_match", candidate_cat_ids: [cat.id] } });
    const { id } = await db.transaction((tx) => fileReport(tx, { sightingId: s.id, catId: null, claim: "injured", note: null, source: "photo", reporterId: null }));
    expect(await db.transaction((tx) => heldCatIds(tx))).toEqual(new Set());
    expect((await act("sighting_merge", { sightingId: s.id, catId: cat.id })).status).toBe(200);
    expect((await db.select().from(reports).where(eq(reports.id, id)))[0].catId).toBe(cat.id);
    expect(await db.transaction((tx) => heldCatIds(tx))).toEqual(new Set([cat.id]));
  });

  it("confirming as a new cat attaches the photo's report to the new cat", async () => {
    const s = await reviewSighting();
    const { id } = await db.transaction((tx) => fileReport(tx, { sightingId: s.id, catId: null, claim: "injured", note: "limping", source: "neighbour", reporterId: null }));
    expect((await act("sighting_confirm_new", { sightingId: s.id })).status).toBe(200);
    const r = (await db.select().from(reports).where(eq(reports.id, id)))[0];
    const [cat] = await db.select().from(cats);
    expect(r.catId).toBe(cat.id);
    expect(r.status).toBe("open");
    // The assessment's pregnant guess no longer writes a flag.
    expect(cat.flags).toEqual([]);
    expect(await db.transaction((tx) => heldCatIds(tx))).toEqual(new Set([cat.id]));
  });

  it("refuses to merge into a cat that does not exist", async () => {
    const s = await reviewSighting();
    expect((await act("sighting_merge", { sightingId: s.id, catId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await sightingRow(s.id)).state).toBe("needs_review");
  });

  it("confirming as a new cat creates one cat with a fixed fuzz, and a double click makes no second", async () => {
    const s = await reviewSighting();
    const [a, b] = await Promise.all([act("sighting_confirm_new", { sightingId: s.id }), act("sighting_confirm_new", { sightingId: s.id })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const all = await db.select().from(cats);
    expect(all).toHaveLength(1);
    const cat = all[0];
    expect(cat).toMatchObject({ name: "Muning", sex: "female", exactLat: 10.2, exactLng: 120.6, locationApproximate: false, status: "spotted", earTipped: null });
    expect(cat.flags).toEqual([]);
    const meters = Math.hypot((cat.fuzzedLat! - 10.2) * 111_320, (cat.fuzzedLng! - 120.6) * 111_320 * Math.cos((10.2 * Math.PI) / 180));
    expect(meters).toBeGreaterThan(290);
    expect(meters).toBeLessThan(710);
    const row = await sightingRow(s.id);
    expect(row).toMatchObject({ state: "new_cat", catId: cat.id });
    expect(row.publicReady).toBe(true);
  });

  it("confirms a sighting the AI could not read, with plain defaults", async () => {
    const s = await reviewSighting({ assessment: null, exactLat: null, exactLng: null });
    expect((await act("sighting_confirm_new", { sightingId: s.id })).status).toBe(200);
    const [cat] = await db.select().from(cats);
    expect(cat).toMatchObject({ name: "Little stray", sex: "unknown", locationApproximate: true });
    expect((await sightingRow(s.id)).publicReady).toBe(false);
  });

  it("rejects once, and not a sighting that is no longer waiting", async () => {
    const s = await reviewSighting();
    expect((await act("sighting_reject", { sightingId: s.id })).status).toBe(200);
    expect((await sightingRow(s.id)).state).toBe("rejected");
    expect((await act("sighting_reject", { sightingId: s.id })).status).toBe(409);
    expect((await act("sighting_confirm_new", { sightingId: s.id })).status).toBe(409);
    expect(await db.select().from(cats)).toHaveLength(0);
  });
});

// ---------- Cat edits ----------

async function makeCat(status: string, over: Partial<typeof cats.$inferInsert> = {}) {
  const [cat] = await db.insert(cats).values({ name: `Cat${++seq}`, areaName: "x", status, ...over }).returning();
  return cat;
}

describe("cat details", () => {
  it("setting pregnant, injured or sick files a confirmed caretaker report and holds the cat; kitten does not", async () => {
    const cat = await makeCat("spotted");
    expect((await act("cat_set_details", { catId: cat.id, sex: "female", flags: ["sick", "kitten"] })).status).toBe(200);
    const rows = await db.select().from(reports).where(eq(reports.catId, cat.id));
    expect(rows).toMatchObject([{ claim: "sick", source: "caretaker", status: "confirmed", reporterId: caretaker.id }]);
    expect(await db.transaction((tx) => heldCatIds(tx))).toEqual(new Set([cat.id]));
    // Saving the card again, unchanged, files nothing new.
    expect((await act("cat_set_details", { catId: cat.id, sex: "female", flags: ["sick", "kitten"] })).status).toBe(200);
    expect(await db.select().from(reports)).toHaveLength(1);

  });

  it("removing a flag with a confirmed hold report is refused: a vet clears it, not the desk", async () => {
    const cat = await makeCat("spotted");
    await act("cat_set_details", { catId: cat.id, sex: "female", flags: ["injured", "kitten"] });
    const refused = await act("cat_set_details", { catId: cat.id, sex: "male", flags: ["kitten"] });
    expect(refused).toMatchObject({ status: 409, message: "A vet clears this. Ask the vet to check." });
    // Nothing changed: the flag, the sex, the report and the hold all stand.
    expect(await catRow(cat.id)).toMatchObject({ sex: "female", flags: ["injured", "kitten"] });
    expect(await db.select().from(reports)).toMatchObject([{ claim: "injured", status: "confirmed" }]);
    expect(await db.transaction((tx) => heldCatIds(tx))).toEqual(new Set([cat.id]));
    // A kitten flag is not a hold and can come off.
    expect((await act("cat_set_details", { catId: cat.id, sex: "female", flags: ["injured"] })).status).toBe(200);
    // Once a vet has cleared the cat, the flag can come off.
    const [vet] = await db.insert(users).values({ username: `vet_${++seq}`, role: "vet" }).returning();
    await db.transaction((tx) => clearCatForSurgery(tx, cat.id, vet.id));
    expect((await act("cat_set_details", { catId: cat.id, sex: "female", flags: [] })).status).toBe(200);
    expect(await db.select().from(reports)).toMatchObject([{ claim: "injured", status: "cleared", decidedBy: vet.id }]);
  });

  it("setting a flag confirms the open reports for it instead of filing a second card", async () => {
    const cat = await makeCat("spotted");
    const s = (await db.insert(sightings).values({ originalKey: "k", catId: cat.id, state: "matched" }).returning())[0];
    const { id } = await db.transaction((tx) => fileReport(tx, { sightingId: s.id, catId: cat.id, claim: "injured", note: null, source: "photo", reporterId: null }));
    await act("cat_set_details", { catId: cat.id, sex: "female", flags: ["injured"] });
    const rows = await db.select().from(reports);
    expect(rows).toMatchObject([{ id, status: "confirmed", decidedBy: caretaker.id }]);
  });

  it("rejecting a sighting dismisses the reports that have no cat", async () => {
    const s = await reviewSighting();
    const { id } = await db.transaction((tx) => fileReport(tx, { sightingId: s.id, catId: null, claim: "injured", note: null, source: "photo", reporterId: null }));
    expect((await act("sighting_reject", { sightingId: s.id })).status).toBe(200);
    expect((await db.select().from(reports).where(eq(reports.id, id)))[0]).toMatchObject({ status: "dismissed", catId: null, decidedBy: caretaker.id });
  });

  it("settling a sighting never fails because of a repeated report", async () => {
    const cat = await makeCat("spotted");
    const [me] = await db.insert(users).values({ username: `neighbour_${++seq}`, role: "donor" }).returning();
    const s = await reviewSighting({ caughtByUserId: me.id });
    const again = () => db.transaction((tx) => fileReport(tx, { sightingId: s.id, catId: null, claim: "injured", note: null, source: "neighbour", reporterId: me.id }));
    await again();
    await expect(again()).rejects.toMatchObject({ reason: "already_today" });
    expect((await act("sighting_merge", { sightingId: s.id, catId: cat.id })).status).toBe(200);
  });

  it("sets sex and flags from validated values only", async () => {
    const cat = await makeCat("spotted");
    expect((await act("cat_set_details", { catId: cat.id, sex: "female", flags: ["kitten"] })).status).toBe(200);
    expect(await catRow(cat.id)).toMatchObject({ sex: "female", flags: ["kitten"] });
    expect((await act("cat_set_details", { catId: cat.id, sex: "robot", flags: [] })).status).toBe(400);
    expect((await act("cat_set_details", { catId: cat.id, sex: "male", flags: ["bogus"] })).status).toBe(400);
    expect((await act("cat_set_details", { catId: cat.id, sex: "male", flags: [] })).status).toBe(200);
    expect(await catRow(cat.id)).toMatchObject({ sex: "male", flags: [] });
  });

  it("ear-tip present on a spotted cat marks it neutered", async () => {
    const cat = await makeCat("spotted");
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "present" })).status).toBe(200);
    expect(await catRow(cat.id)).toMatchObject({ status: "neutered", earTipped: true });
  });

  it("ear-tip present on a queued cat with no money moved goes queued to neutered", async () => {
    const cat = await makeCat("queued", { earTipped: false });
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "present" })).status).toBe(200);
    expect(await catRow(cat.id)).toMatchObject({ status: "neutered", earTipped: true });
  });

  it("refuses that for a queued cat with an allocation or a payout", async () => {
    const funded = await makeCat("queued", { earTipped: false });
    await fundCat(funded.id, 50000);
    const r = await act("cat_set_ear_tip", { catId: funded.id, earTip: "present" });
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/money/i);
    expect(await catRow(funded.id)).toMatchObject({ status: "queued", earTipped: false });

    const w = await makeWorld();
    await db.update(cats).set({ status: "queued" }).where(eq(cats.id, w.cat.id));
    await db.update(allocations).set({ catId: null }).where(eq(allocations.catId, w.cat.id));
    await addPayout(w, { amount: 45000, status: "failed" });
    expect((await act("cat_set_ear_tip", { catId: w.cat.id, earTip: "present" })).status).toBe(409);
  });

  it("ear-tip absent on a spotted cat queues it and wakes the agent", async () => {
    const cat = await makeCat("spotted");
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "absent" })).status).toBe(200);
    const row = await catRow(cat.id);
    expect(row).toMatchObject({ status: "queued", earTipped: false });
    expect(row.queuedAt).not.toBeNull();
    expect(await wakeupKinds()).toContain("cat_queued");
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "absent" })).status).toBe(200);
    expect((await db.select().from(wakeups)).filter((w) => w.kind === "cat_queued")).toHaveLength(1);
  });

  it("will not change the ear-tip of a cat already in the money flow", async () => {
    const cat = await makeCat("booked");
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "present" })).status).toBe(409);
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "absent" })).status).toBe(409);
    expect((await act("cat_set_ear_tip", { catId: cat.id, earTip: "perhaps" })).status).toBe(400);
  });

  it("marks adoptable then adopted through the state machine, and refuses a skip", async () => {
    const cat = await makeCat("neutered", { earTipped: true });
    expect((await act("cat_adopted", { catId: cat.id })).status).toBe(409);
    expect((await act("cat_adoptable", { catId: cat.id })).status).toBe(200);
    expect((await act("cat_adoptable", { catId: cat.id })).status).toBe(200);
    expect((await catRow(cat.id)).status).toBe("adoptable");
    expect((await act("cat_adopted", { catId: cat.id })).status).toBe(200);
    expect((await catRow(cat.id)).status).toBe("adopted");
    const young = await makeCat("spotted");
    const r = await act("cat_adoptable", { catId: young.id });
    expect(r.status).toBe(409);
    expect(r.message).not.toMatch(/Illegal cat transition/);
  });
});

// ---------- Photos ----------

describe("photos", () => {
  async function heldSighting(assessment: unknown) {
    const [cat] = await db.insert(cats).values({ name: "Photo cat", areaName: "x", status: "neutered", earTipped: true }).returning();
    const { key } = await storeOriginal(await image());
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "new_cat", assessment: assessment as object }).returning();
    return { cat, s };
  }

  it("publishing with no regions needs the tick, then publishes a scrubbed copy the public page shows", async () => {
    const { cat, s } = await heldSighting({ ...ASSESS });
    expect((await act("photo_publish", { sightingId: s.id })).status).toBe(400);
    expect((await sightingRow(s.id)).publicReady).toBe(false);
    expect(await act("photo_publish", { sightingId: s.id, noSensitive: true })).toMatchObject({ status: 200, message: "Published with only the cat sharp." });
    const row = await sightingRow(s.id);
    expect(row.publicReady).toBe(true);
    expect(row.publicKey).toMatch(/^photos\//);
    expect(() => (getStorage() as unknown as { readPublic: (k: string) => Buffer }).readPublic(row.publicKey!)).not.toThrow();
    expect((await getCatCard(cat.id))!.cat.photoUrl).not.toBeNull();
    expect((await act("photo_publish", { sightingId: s.id, noSensitive: true })).status).toBe(409);
  });

  it("publishes cat-only: sharp around the stored box, blurred far from it", async () => {
    const [cat] = await db.insert(cats).values({ name: "Box cat", areaName: "x", status: "neutered", earTipped: true }).returning();
    const photo = await sharp(await checkerImage(400, 300, { left: 0, top: 0, width: 400, height: 300 })).jpeg({ quality: 95 }).toBuffer();
    const { key } = await storeOriginal(photo);
    const [s] = await db
      .insert(sightings)
      .values({ catId: cat.id, originalKey: key, state: "new_cat", assessment: { ...ASSESS }, catBox: { x: 0, y: 0.2, w: 0.3, h: 0.6 } })
      .returning();
    expect((await act("photo_publish", { sightingId: s.id, noSensitive: true })).status).toBe(200);
    const out = (getStorage() as unknown as { readPublic: (k: string) => Buffer }).readPublic((await sightingRow(s.id)).publicKey!);
    const varAt = async (img: Buffer, left: number, top: number) => variance(await greyRegion(img, { left, top, width: 20, height: 20 }));
    const sharpVar = await varAt(photo, 20, 100);
    expect(await varAt(out, 60, 140)).toBeGreaterThan(sharpVar * 0.7);
    expect(await varAt(out, 360, 20)).toBeLessThan(sharpVar * 0.1);
  });

  it("stored regions are used without the tick", async () => {
    const { s } = await heldSighting({ ...ASSESS, sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] });
    expect((await act("photo_publish", { sightingId: s.id })).status).toBe(200);
    expect((await sightingRow(s.id)).publicReady).toBe(true);
  });

  it("listed regions are not enough when the AI was not sure the rest is clear: the tick is needed", async () => {
    const { s } = await heldSighting({ ...ASSESS, no_sensitive_content: false, sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] });
    const q = (await getCaretakerQueue()).heldPhotos.find((p) => p.sightingId === s.id)!;
    expect(q).toMatchObject({ hasRegions: true, needsTick: true });
    expect((await act("photo_publish", { sightingId: s.id })).status).toBe(400);
    expect((await sightingRow(s.id)).publicReady).toBe(false);
    expect((await act("photo_publish", { sightingId: s.id, noSensitive: true })).status).toBe(200);
    expect((await sightingRow(s.id)).publicReady).toBe(true);
  });

  it("a row saved before the field existed keeps today's rule: regions without a tick, none with one", async () => {
    const { no_sensitive_content: _gone, ...old } = ASSESS;
    void _gone;
    const withRegions = await heldSighting({ ...old, sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] });
    expect((await act("photo_publish", { sightingId: withRegions.s.id })).status).toBe(200);
    const none = await heldSighting({ ...old });
    expect((await act("photo_publish", { sightingId: none.s.id })).status).toBe(400);
  });

  it("confirming a new cat does not publish a photo the AI did not vouch for", async () => {
    const vouched = await reviewSighting({ assessment: { ...ASSESS, review_reason: "ai_unusable", candidate_cat_ids: [] } });
    expect((await act("sighting_confirm_new", { sightingId: vouched.id })).status).toBe(200);
    expect((await sightingRow(vouched.id)).publicReady).toBe(true);
    const unsure = await reviewSighting({ assessment: { ...ASSESS, no_sensitive_content: false, review_reason: "ai_unusable", candidate_cat_ids: [] } });
    expect((await act("sighting_confirm_new", { sightingId: unsure.id })).status).toBe(200);
    expect((await sightingRow(unsure.id)).publicReady).toBe(false);
  });

  it("holding removes the photo from public pages", async () => {
    const { cat, s } = await heldSighting({ ...ASSESS });
    await act("photo_publish", { sightingId: s.id, noSensitive: true });
    expect((await act("photo_hold", { sightingId: s.id })).status).toBe(200);
    const row = await sightingRow(s.id);
    expect(row).toMatchObject({ publicReady: false, publicKey: null });
    expect((await getCatCard(cat.id))!.cat.photoUrl).toBeNull();
    expect((await act("photo_hold", { sightingId: s.id })).status).toBe(409);
  });

  it("holding deletes the public copy, so its old address stops working", async () => {
    const { s } = await heldSighting({ ...ASSESS });
    await act("photo_publish", { sightingId: s.id, noSensitive: true });
    const key = (await sightingRow(s.id)).publicKey!;
    const storage = getStorage() as unknown as { readPublic: (k: string) => Buffer };
    expect(() => storage.readPublic(key)).not.toThrow();
    expect((await act("photo_hold", { sightingId: s.id })).status).toBe(200);
    expect(() => storage.readPublic(key)).toThrow();
  });

  it("a delete that fails is logged and the hold still stands", async () => {
    const { s } = await heldSighting({ ...ASSESS });
    await act("photo_publish", { sightingId: s.id, noSensitive: true });
    const key = (await sightingRow(s.id)).publicKey!;
    const err = Object.assign(new Error("denied"), { name: "AccessDenied", statusCode: 403 });
    vi.spyOn(getStorage(), "deletePublic").mockRejectedValueOnce(err);
    const logged = vi.spyOn(console, "error");
    expect((await act("photo_hold", { sightingId: s.id })).status).toBe(200);
    expect(await sightingRow(s.id)).toMatchObject({ publicReady: false, publicKey: null });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("AccessDenied (HTTP 403)"));
    expect(JSON.stringify(logged.mock.calls)).not.toContain(key);
  });

  it("publishing a plain photo that is waiting for the worker keeps the worker from overwriting it", async () => {
    const { cat } = await heldSighting({ ...ASSESS });
    const { key } = await storeOriginal(await image());
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "new_cat", assessment: { ...ASSESS } as object, needsDevelop: true, createdAt: new Date(Date.now() - 3_600_000) }).returning();
    expect((await act("photo_publish", { sightingId: s.id, noSensitive: true })).status).toBe(200);
    const mine = (await sightingRow(s.id)).publicKey!;
    expect((await sightingRow(s.id)).developedAt).not.toBeNull();
    setCatFinderForTests(async () => ({ box: null, mask: null }));
    try {
      expect(await developNext()).toBe("idle");
    } finally {
      setCatFinderForTests(null);
    }
    expect((await sightingRow(s.id)).publicKey).toBe(mine);
    expect(() => (getStorage() as unknown as { readPublic: (k: string) => Buffer }).readPublic(mine)).not.toThrow();
  });

  it("a publish that loses the race to another publish deletes the copy it made", async () => {
    const { s } = await heldSighting({ ...ASSESS });
    const real = getStorage().putPublic.bind(getStorage());
    const made: string[] = [];
    vi.spyOn(getStorage(), "putPublic").mockImplementationOnce(async (key, buf, type) => {
      made.push(key);
      await real(key, buf, type);
      await db.update(sightings).set({ publicReady: true, publicKey: "photos/00000000-0000-4000-8000-000000000000.jpg" }).where(eq(sightings.id, s.id));
    });
    expect((await act("photo_publish", { sightingId: s.id, noSensitive: true })).status).toBe(409);
    expect(made).toHaveLength(1);
    expect(() => (getStorage() as unknown as { readPublic: (k: string) => Buffer }).readPublic(made[0])).toThrow();
  });

  it("holding a plain photo that is still waiting for the worker stops the worker publishing it", async () => {
    const { cat } = await heldSighting({ ...ASSESS });
    const { key } = await storeOriginal(await image());
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "new_cat", needsDevelop: true, createdAt: new Date(Date.now() - 3_600_000) }).returning();
    expect((await act("photo_hold", { sightingId: s.id })).status).toBe(200);
    expect((await sightingRow(s.id)).developedAt).not.toBeNull();
    setCatFinderForTests(async () => ({ box: null, mask: null }));
    try {
      expect(await developNext()).toBe("idle");
    } finally {
      setCatFinderForTests(null);
    }
    expect(await sightingRow(s.id)).toMatchObject({ publicReady: false, publicKey: null });
  });
});

// ---------- Rotating a photo ----------

describe("photo_rotate", () => {
  type Mem = { readPublic: (k: string) => Buffer };
  const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  async function rotatable(over: Partial<typeof sightings.$inferInsert> = {}) {
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
    const { key } = await storeOriginal(jpeg);
    const [cat] = await db.insert(cats).values({ name: "Turn cat", areaName: "x", status: "neutered", earTipped: true }).returning();
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "new_cat", catBox: BOX, assessment: { ...ASSESS }, ...over }).returning();
    return { cat, s, key };
  }
  const size = async (key: string) => {
    const m = await sharp(await getStorage().getPrivate(key)).metadata();
    return [m.width, m.height];
  };

  it("turns the original in place and the stored box with it", async () => {
    const { s, key } = await rotatable();
    expect((await act("photo_rotate", { sightingId: s.id, direction: "right" })).status).toBe(200);
    expect(await size(key)).toEqual([300, 400]);
    const box = (await sightingRow(s.id)).catBox as typeof BOX;
    expect(box.x).toBeCloseTo(0.4);
    expect(box.y).toBeCloseTo(0.1);
    expect(box.w).toBeCloseTo(0.4);
    expect(box.h).toBeCloseTo(0.3);
    expect((await act("photo_rotate", { sightingId: s.id, direction: "left" })).status).toBe(200);
    expect(await size(key)).toEqual([400, 300]);
    expect(((await sightingRow(s.id)).catBox as typeof BOX).x).toBeCloseTo(0.1);
  });

  it("a public photo gets a new public copy and the old address stops working", async () => {
    const { s } = await rotatable();
    expect((await act("photo_publish", { sightingId: s.id, noSensitive: true })).status).toBe(200);
    const old = (await sightingRow(s.id)).publicKey!;
    expect((await act("photo_rotate", { sightingId: s.id, direction: "right" })).status).toBe(200);
    const row = await sightingRow(s.id);
    expect(row.publicReady).toBe(true);
    expect(row.publicKey).not.toBe(old);
    const storage = getStorage() as unknown as Mem;
    expect(() => storage.readPublic(old)).toThrow();
    const meta = await sharp(storage.readPublic(row.publicKey!)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  it("a private photo publishes nothing", async () => {
    const { s } = await rotatable();
    expect((await act("photo_rotate", { sightingId: s.id, direction: "left" })).status).toBe(200);
    expect(await sightingRow(s.id)).toMatchObject({ publicReady: false, publicKey: null });
  });

  it("a photo still waiting for the worker is only turned, and the worker develops the turned original", async () => {
    const { s, key } = await rotatable({ needsDevelop: true, createdAt: new Date(Date.now() - 3_600_000) });
    expect((await act("photo_rotate", { sightingId: s.id, direction: "right" })).status).toBe(200);
    expect(await sightingRow(s.id)).toMatchObject({ publicReady: false, publicKey: null, developedAt: null });
    expect(await size(key)).toEqual([300, 400]);
    setCatFinderForTests(async () => ({ box: null, mask: null }));
    try {
      expect(await developNext()).toBe("developed");
    } finally {
      setCatFinderForTests(null);
    }
    const row = await sightingRow(s.id);
    expect(row.publicReady).toBe(true);
    const meta = await sharp((getStorage() as unknown as Mem).readPublic(row.publicKey!)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  it("a rotation during develop leaves the row undeveloped, and the next tick publishes the turned photo", async () => {
    const { s } = await rotatable({ needsDevelop: true, createdAt: new Date(Date.now() - 3_600_000) });
    setCatFinderForTests(async () => {
      expect((await act("photo_rotate", { sightingId: s.id, direction: "right" })).status).toBe(200);
      return { box: null, mask: null };
    });
    try {
      await developNext();
      const mid = await sightingRow(s.id);
      expect(mid).toMatchObject({ publicReady: false, publicKey: null, developedAt: null });
      expect(mid.developAttempts).toBe(0);
    } finally {
      setCatFinderForTests(null);
    }
    setCatFinderForTests(async () => ({ box: null, mask: null }));
    try {
      expect(await developNext()).toBe("developed");
    } finally {
      setCatFinderForTests(null);
    }
    const row = await sightingRow(s.id);
    expect(row.publicReady).toBe(true);
    const meta = await sharp((getStorage() as unknown as Mem).readPublic(row.publicKey!)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  it("turns the marked areas with the photo", async () => {
    const { s } = await rotatable({ assessment: { ...ASSESS, sensitive_regions: [BOX] } });
    await act("photo_rotate", { sightingId: s.id, direction: "right" });
    const r = ((await sightingRow(s.id)).assessment as { sensitive_regions: (typeof BOX)[] }).sensitive_regions[0];
    expect([r.x, r.y, r.w, r.h].map((n) => Math.round(n * 100) / 100)).toEqual([0.4, 0.1, 0.4, 0.3]);
  });

  it("a delete that fails is logged and the rotation still stands", async () => {
    const { s } = await rotatable();
    await act("photo_publish", { sightingId: s.id, noSensitive: true });
    vi.spyOn(getStorage(), "deletePublic").mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied", statusCode: 403 }));
    expect((await act("photo_rotate", { sightingId: s.id, direction: "right" })).status).toBe(200);
    expect(await size((await sightingRow(s.id)).originalKey)).toEqual([300, 400]);
  });

  it("answers not found for an unknown sighting and 400 for a bad direction", async () => {
    expect((await act("photo_rotate", { sightingId: "00000000-0000-4000-8000-000000000000", direction: "left" })).status).toBe(404);
    const { s } = await rotatable();
    expect((await act("photo_rotate", { sightingId: s.id, direction: "up" })).status).toBe(400);
  });

  it("is audited with the direction", async () => {
    const { s } = await rotatable();
    await act("photo_rotate", { sightingId: s.id, direction: "left" });
    const rows = await actionsNamed("photo_rotated");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].inputs)).toContain('"direction":"left"');
  });
});

// ---------- Wakeups ----------

describe("photo_publish and a rotation", () => {
  it("a rotation while the copy is made wins: the copy is deleted and the photo stays held", async () => {
    const [cat] = await db.insert(cats).values({ name: "Spin cat", areaName: "x", status: "neutered", earTipped: true }).returning();
    const { key } = await storeOriginal(await image());
    const [s] = await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "new_cat", assessment: { ...ASSESS } }).returning();
    const real = getStorage().putPublic.bind(getStorage());
    const made: string[] = [];
    vi.spyOn(getStorage(), "putPublic").mockImplementationOnce(async (k, buf, type) => {
      made.push(k);
      await real(k, buf, type);
      await db.update(sightings).set({ photoVersion: 1 }).where(eq(sightings.id, s.id));
    });
    expect(await act("photo_publish", { sightingId: s.id, noSensitive: true })).toMatchObject({
      status: 409,
      message: "The photo was rotated while it was being published. Try again.",
    });
    expect(() => (getStorage() as unknown as { readPublic: (k: string) => Buffer }).readPublic(made[0])).toThrow();
    expect(await sightingRow(s.id)).toMatchObject({ publicReady: false, publicKey: null });
  });
});

type Mem = { readPublic: (k: string) => Buffer };
/** A cat made by a public no-AI photo, developed and public. */
async function plainCat() {
  const finder = (await db.insert(users).values({ username: `finder${++seq}`, role: "donor" }).returning())[0];
  const [cat] = await db.insert(cats).values({ name: `Plain${seq}`, areaName: "x", fuzzedLat: 10.2, fuzzedLng: 120.6 }).returning();
  const { key } = await storeOriginal(await image());
  const publicKey = newPublicKey();
  await getStorage().putPublic(publicKey, await image(), "image/jpeg");
  const [s] = await db
    .insert(sightings)
    .values({ catId: cat.id, originalKey: key, caughtByUserId: finder.id, state: "new_cat", needsDevelop: true, developedAt: new Date(), publicReady: true, publicKey })
    .returning();
  return { cat, s, key, publicKey, finder };
}

describe("cat_remove", () => {

  it("removes a plain cat: gone from the yard, its public copy deleted, its votes gone, an audit row left", async () => {
    const { cat, s, key, publicKey, finder } = await plainCat();
    // Votes and name ideas do not count as history; they go with the cat.
    await db.insert(earTipFlags).values({ catId: cat.id, userId: finder.id, value: "no" });
    await db.insert(nameSuggestions).values({ catId: cat.id, requesterId: finder.id, name: "Mali" });
    await db.insert(agentActions).values({ action: "sex_answered", inputs: { catId: cat.id, userId: finder.id }, reason: "x", status: "done" });
    expect((await getYard(null)).cats.map((c) => c.id)).toContain(cat.id);

    expect(await act("cat_remove", { catId: cat.id })).toMatchObject({ status: 200, ok: true });

    expect(await catRow(cat.id)).toBeUndefined();
    expect(await sightingRow(s.id)).toBeUndefined();
    expect(await db.select().from(earTipFlags)).toHaveLength(0);
    expect(await db.select().from(nameSuggestions)).toHaveLength(0);
    expect((await getYard(null)).cats.map((c) => c.id)).not.toContain(cat.id);
    expect(() => (getStorage() as unknown as Mem).readPublic(publicKey)).toThrow();
    // The private original stays: there is no permission to delete it.
    await expect(getStorage().getPrivate(key)).resolves.toBeInstanceOf(Buffer);
    const [row] = await actionsNamed("cat_removed");
    expect(row).toMatchObject({ status: "done", approvedBy: caretaker.id, inputs: { catId: cat.id, name: cat.name, sightingIds: [s.id] } });
    const shown = (await listAgentActions()).find((f) => f.id === row.id);
    expect(shown?.action).toBe("Caretaker removed a cat");
    expect((await act("cat_remove", { catId: cat.id })).status).toBe(404);
  });

  it("refuses a cat with history: a report, an AI-path photo, or any step past spotted", async () => {
    const reported = await plainCat();
    await db.insert(reports).values({
      catId: reported.cat.id,
      sightingId: reported.s.id,
      claim: "injured",
      source: "neighbour",
      reporterId: reported.finder.id,
      reportedOn: new Date().toISOString().slice(0, 10),
    });
    const aiShot = await plainCat();
    const { key } = await storeOriginal(await image());
    await db.insert(sightings).values({ catId: aiShot.cat.id, originalKey: key, state: "matched" });
    const queued = await plainCat();
    await db.update(cats).set({ status: "queued" }).where(eq(cats.id, queued.cat.id));
    for (const { cat, publicKey } of [reported, aiShot, queued]) {
      expect(await act("cat_remove", { catId: cat.id })).toMatchObject({ status: 409, message: "This cat has history. Hold its photos instead." });
      expect(await catRow(cat.id)).toBeDefined();
      expect(() => (getStorage() as unknown as Mem).readPublic(publicKey)).not.toThrow();
    }
    expect(await actionsNamed("cat_removed")).toHaveLength(0);
  });

  it("is refused at the route for anyone but a caretaker", async () => {
    const { cat } = await plainCat();
    const donor = (await db.insert(users).values({ username: `donor${++seq}`, role: "donor" }).returning())[0];
    await signIn(donor, "donor");
    expect((await act("cat_remove", { catId: cat.id })).status).toBe(403);
    await signIn(await makeVet(), "vet");
    expect((await act("cat_remove", { catId: cat.id })).status).toBe(403);
    expect(await catRow(cat.id)).toBeDefined();
  });
});

describe("cat_merge", () => {
  /** The real cat: one the AI started from its own photo, with a published copy. */
  async function realCat() {
    const [cat] = await db.insert(cats).values({ name: `Real${++seq}`, areaName: "x", fuzzedLat: 10.2, fuzzedLng: 120.6 }).returning();
    const { key } = await storeOriginal(await image());
    const publicKey = newPublicKey();
    await getStorage().putPublic(publicKey, await image(), "image/jpeg");
    await db.insert(sightings).values({ catId: cat.id, originalKey: key, state: "new_cat", publicReady: true, publicKey });
    return cat;
  }

  it("moves the duplicate's photos to the real cat: the count goes up, the duplicate leaves the yard, an audit row is left", async () => {
    const real = await realCat();
    const dup = await plainCat();
    await db.insert(earTipFlags).values({ catId: dup.cat.id, userId: dup.finder.id, value: "no" });
    await db.insert(nameSuggestions).values({ catId: dup.cat.id, requesterId: dup.finder.id, name: "Mali" });
    expect((await getCatCard(real.id))!.cat.sightingCount).toBe(1);

    expect(await act("cat_merge", { catId: dup.cat.id, intoCatId: real.id })).toMatchObject({ status: 200, ok: true });

    expect(await catRow(dup.cat.id)).toBeUndefined();
    expect(await sightingRow(dup.s.id)).toMatchObject({ catId: real.id, state: "matched", publicReady: true, publicKey: dup.publicKey });
    const card = (await getCatCard(real.id))!;
    expect(card.cat.sightingCount).toBe(2);
    // The public copy stays where it was and now shows on the real cat's page.
    expect(card.sightings.map((s) => s.id)).toContain(dup.s.id);
    expect(() => (getStorage() as unknown as Mem).readPublic(dup.publicKey)).not.toThrow();
    expect(await db.select().from(earTipFlags)).toHaveLength(0);
    expect(await db.select().from(nameSuggestions)).toHaveLength(0);
    const yard = (await getYard(null)).cats.map((c) => c.id);
    expect(yard).not.toContain(dup.cat.id);
    expect(yard).toContain(real.id);
    const [row] = await actionsNamed("cat_merged");
    expect(row).toMatchObject({
      status: "done",
      approvedBy: caretaker.id,
      inputs: { catId: dup.cat.id, name: dup.cat.name, intoCatId: real.id, intoName: real.name, sightingIds: [dup.s.id] },
    });
    expect((await listAgentActions()).find((f) => f.id === row.id)?.action).toBe("Caretaker merged a cat added twice");
    // The merge leaves no history against the real cat.
    expect((await act("cat_merge", { catId: dup.cat.id, intoCatId: real.id })).status).toBe(404);
  });

  it("refuses a duplicate with a report (409) and changes nothing", async () => {
    const real = await realCat();
    const dup = await plainCat();
    await db.insert(reports).values({
      catId: dup.cat.id,
      sightingId: dup.s.id,
      claim: "injured",
      source: "neighbour",
      reporterId: dup.finder.id,
      reportedOn: new Date().toISOString().slice(0, 10),
    });
    expect(await act("cat_merge", { catId: dup.cat.id, intoCatId: real.id })).toMatchObject({
      status: 409,
      message: "This cat has history, so it can't be moved into another cat.",
    });
    expect(await catRow(dup.cat.id)).toBeDefined();
    expect(await sightingRow(dup.s.id)).toMatchObject({ catId: dup.cat.id, state: "new_cat" });
    expect(await actionsNamed("cat_merged")).toHaveLength(0);
  });

  it("refuses merging a cat into itself (409) and an unknown target (404)", async () => {
    const dup = await plainCat();
    expect(await act("cat_merge", { catId: dup.cat.id, intoCatId: dup.cat.id })).toMatchObject({ status: 409 });
    expect(await act("cat_merge", { catId: dup.cat.id, intoCatId: "00000000-0000-4000-8000-000000000999" })).toMatchObject({ status: 404 });
    expect(await catRow(dup.cat.id)).toBeDefined();
    expect(await sightingRow(dup.s.id)).toMatchObject({ catId: dup.cat.id });
    expect(await actionsNamed("cat_merged")).toHaveLength(0);
  });

  it("is refused at the route for anyone but a caretaker", async () => {
    const real = await realCat();
    const dup = await plainCat();
    const donor = (await db.insert(users).values({ username: `donor${++seq}`, role: "donor" }).returning())[0];
    await signIn(donor, "donor");
    expect((await act("cat_merge", { catId: dup.cat.id, intoCatId: real.id })).status).toBe(403);
    expect(await catRow(dup.cat.id)).toBeDefined();
  });
});

describe("failed wakeups", () => {
  it("retry puts it back to pending once, dismiss closes it", async () => {
    const [w] = await db.insert(wakeups).values({ kind: "cat_queued", payload: {}, status: "failed", attempts: 3 }).returning();
    expect((await act("wakeup_retry", { wakeupId: w.id })).status).toBe(200);
    const [row] = await db.select().from(wakeups).where(eq(wakeups.id, w.id));
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect((await act("wakeup_retry", { wakeupId: w.id })).status).toBe(409);
    const [x] = await db.insert(wakeups).values({ kind: "cat_queued", payload: {}, status: "failed", attempts: 3 }).returning();
    expect((await act("wakeup_dismiss", { wakeupId: x.id })).status).toBe(200);
    expect((await db.select().from(wakeups).where(eq(wakeups.id, x.id)))[0].status).toBe("done");
  });
});

// ---------- The queue ----------

describe("the queue", () => {
  it("is empty on a fresh colony", async () => {
    const q = await getCaretakerQueue();
    for (const [name, list] of Object.entries(q)) expect(list, name).toEqual([]);
  });

  it("holds every kind of waiting thing, with exact location only here", async () => {
    vi.stubEnv("DEMO_MODE", "false"); // staff see exact places only outside the demo
    const w = await makeWorld({ funded: 250000 });
    await db.update(cats).set({ exactLat: 10.5, exactLng: 120.5 }).where(eq(cats.id, w.cat.id));
    await addPayout(w, { amount: 45000, status: "awaiting_approval" });
    const w2 = await makeWorld();
    await addPayout(w2, { amount: 45000, status: "needs_review", batchId: "B-9" });
    await db.update(payouts).set({ lastGatewayError: "gateway said no" }).where(eq(payouts.status, "needs_review"));
    const w3 = await makeWorld();
    const old = await addPayout(w3, { amount: 45000, status: "sent", batchId: "B-10", lastAttemptAt: new Date(Date.now() - 2 * 3_600_000) });
    const w4 = await makeWorld();
    await addPayout(w4, { amount: 45000, status: "sent", batchId: "B-11", lastAttemptAt: new Date(Date.now() - 5 * 60_000) });
    const sight = await reviewSighting({ catId: w.cat.id });
    const ev = await evidenceWorld();
    await db.transaction((tx) => fileReview(tx, "Something odd", "Please look."));
    await db.insert(wakeups).values({ kind: "cat_queued", payload: {}, status: "failed", attempts: 3 });
    const heldCat = await makeCat("neutered", { earTipped: true });
    const { key } = await storeOriginal(await image());
    await db.insert(sightings).values({ catId: heldCat.id, originalKey: key, state: "new_cat" });

    const q = await getCaretakerQueue();
    expect(q.awaitingApproval).toHaveLength(1);
    expect(q.needsReview).toHaveLength(1);
    expect(q.needsReview[0].lastGatewayError).toBe("gateway said no");
    expect(q.longSent.map((p) => p.id)).toEqual([old.id]);
    expect(q.sightings.map((s) => s.id)).toEqual([sight.id]);
    expect(q.sightings[0].exact).toMatchObject({ lat: 10.2, lng: 120.6 });
    expect(q.receipts.map((r) => r.id)).toEqual([ev.receipt.id]);
    expect(q.receipts[0].parsed?.total_centavos).toBe(120000);
    expect(q.receipts[0].depositPaid).toBe(45000);
    expect(q.reviews.map((r) => r.subject)).toContain("Something odd");
    expect(q.failedWakeups).toHaveLength(1);
    expect(q.heldPhotos.some((p) => p.catName === heldCat.name)).toBe(true);
  });
});

// ---------- Public feed ----------

describe("audit rows on the public feed", () => {
  it("render with a plain label and never carry a caretaker's note", async () => {
    const w = await evidenceWorld();
    await act("guardrails_update", rules({ maxPerCat: "3000" }));
    await act("evidence_accept", { receiptId: w.receipt.id, total: "1200", earTipConfirmed: true, note: "NOTE-SENTINEL-1" });
    const p = await addPayout(await makeWorld(), { amount: 45000, status: "sent", batchId: "B-77" });
    await act("payout_note", { payoutId: p.id, note: "NOTE-SENTINEL-2" });
    await act("payee_remove", { userId: w.vet.id });
    const feed = await listAgentActions();
    const text = JSON.stringify(feed);
    expect(text).not.toMatch(/NOTE-SENTINEL|gateway|inputs/i);
    for (const name of ["guardrails_changed", "evidence_accepted", "payout_note", "payee_removed"]) {
      const [row] = await actionsNamed(name);
      const shown = feed.find((f) => f.id === row.id);
      expect(shown, name).toBeDefined();
      expect(shown!.action, name).not.toBe("Treasurer action");
      expect(shown!.status).toBe("Done");
    }
    expect(feed.length).toBeGreaterThanOrEqual(4);
  });
});

