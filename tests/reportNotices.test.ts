import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { reports } from "../src/server/db/schema";
import { getCaretakerQueue } from "../src/server/caretaker/queue";
import { getVetBooking, listVetDashboard } from "../src/server/vetFlow";
import { approvalNotice, vetNotice } from "../src/lib/reportNotice";
import { truncateAll } from "./helpers/db";
import { addPayout, makeWorld } from "./helpers/payoutFixtures";

beforeEach(truncateAll);
afterAll(closePool);

const addReport = (catId: string, over: Partial<typeof reports.$inferInsert> = {}) =>
  db.insert(reports).values({ catId, claim: "injured", source: "neighbour", reportedOn: "2026-11-03", note: "SECRET NOTE 0917 555", ...over }).returning().then((r) => r[0]);

describe("copy", () => {
  it("the approval card and the vet's booking say it in plain words", () => {
    expect(approvalNotice({ claim: "injured", status: "open" })).toBe("This cat has an open report: hurt. Check it above before you approve.");
    expect(approvalNotice({ claim: "sick", status: "confirmed" })).toBe("A caretaker confirmed this cat is sick. A vet has not cleared it yet.");
    expect(vetNotice({ claim: "injured", status: "confirmed" })).toBe("A caretaker confirmed this cat is hurt.");
    expect(vetNotice({ claim: "injured", status: "open", source: "neighbour" })).toBe("A neighbour says this cat is hurt. A caretaker hasn't checked yet.");
    expect(vetNotice({ claim: "injured", status: "open", source: "photo" })).toBe("The AI thinks this cat may be hurt. A caretaker hasn't checked yet.");
  });

  it("says nothing without a report, for a kitten claim, or for a closed report", () => {
    for (const n of [null, { claim: "kitten", status: "open" }, { claim: "injured", status: "dismissed" }, { claim: "injured", status: "cleared" }]) {
      expect(approvalNotice(n)).toBeNull();
      expect(vetNotice(n)).toBeNull();
    }
  });
});

describe("a report on a cat that is already funded or booked", () => {
  it("the deposit approval card carries the claim and status, never the note", async () => {
    const w = await makeWorld();
    await addPayout(w, { amount: 45000, status: "awaiting_approval" });
    await addReport(w.cat.id);
    const q = await getCaretakerQueue();
    expect(q.awaitingApproval[0].catReport).toEqual({ claim: "injured", status: "open", source: "neighbour" });
    expect(JSON.stringify(q.awaitingApproval)).not.toContain("SECRET NOTE");
  });

  it("is empty with no report, and after a caretaker dismisses it", async () => {
    const w = await makeWorld();
    await addPayout(w, { amount: 45000, status: "awaiting_approval" });
    expect((await getCaretakerQueue()).awaitingApproval[0].catReport).toBeNull();
    const r = await addReport(w.cat.id);
    await db.update(reports).set({ status: "dismissed" }).where(eq(reports.id, r.id));
    expect((await getCaretakerQueue()).awaitingApproval[0].catReport).toBeNull();
  });

  it("the vet's booking shows a confirmed claim over an open one, with claim and status only", async () => {
    const w = await makeWorld();
    await addReport(w.cat.id, { claim: "sick", reportedOn: "2026-11-02" });
    const dash = await listVetDashboard(w.vet.id);
    expect(dash.bookings[0].catReport).toEqual({ claim: "sick", status: "open", source: "neighbour" });
    await addReport(w.cat.id, { claim: "injured", status: "confirmed" });
    const view = await getVetBooking(w.vet.id, w.booking.id);
    expect(view?.booking.catReport).toEqual({ claim: "injured", status: "confirmed", source: "neighbour" });
    expect(JSON.stringify([dash, view])).not.toContain("SECRET NOTE");
  });
});
