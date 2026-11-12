import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { cats, reports, sightings, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/vet" }));

import { VetDesk } from "../src/components/VetDesk";
import { SESSION_COOKIE, signSession, type Role } from "../src/server/session";
import { getCatCard } from "../src/server/public";
import { listVetDashboard } from "../src/server/vetFlow";
import { sampleSightingKey } from "../src/server/seed";

beforeEach(async () => {
  await truncateAll();
  jar.clear();
});
afterAll(closePool);

let seq = 0;
async function signInAs(role: Role) {
  const [u] = await db.insert(users).values({ username: `${role}_${Date.now()}_${++seq}`, role }).returning();
  jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role, username: u.username }));
}
const render = async (view: "todo" | "bookings") => renderToStaticMarkup(await VetDesk({ view }));

describe("the vet desk's two tabs", () => {
  it("refuses anyone who is not a vet the same way on To do and on Bookings", async () => {
    for (const view of ["todo", "bookings"] as const) {
      jar.clear();
      expect(await render(view)).toContain("This page is for partner vets.");
      for (const role of ["donor", "caretaker", "foster"] as const) {
        await signInAs(role);
        const html = await render(view);
        expect(html, `${role} on ${view}`).toContain("This page is for partner vets.");
        expect(html).not.toContain("Cats to check");
        expect(html).not.toContain("You have no bookings yet.");
      }
    }
  });

  it("shows a vet their own desk on each tab, and both pages go through the same check", async () => {
    await signInAs("vet");
    expect(await render("todo")).toContain("Waiting for you");
    expect(await render("bookings")).toContain("You have no bookings yet.");
    for (const [file, view] of [["src/app/vet/page.tsx", "todo"], ["src/app/vet/bookings/page.tsx", "bookings"]] as const) {
      expect(readFileSync(file, "utf8")).toContain(`<VetDesk view="${view}" />`);
    }
  });
});

describe("which picture stands for a cat", () => {
  it("shows a cat's real photo even when a seeded drawing is newer, and the drawing only when there's nothing else", async () => {
    const [cat] = await db.insert(cats).values({ name: "Milo", areaName: "Brgy 1", status: "queued" }).returning();
    const at = (min: number) => new Date(Date.UTC(2026, 10, 12, 8, min));
    await db.insert(sightings).values({ catId: cat.id, originalKey: "originals/real-milo.jpg", publicKey: "photos/real-milo.jpg", publicReady: true, state: "matched", createdAt: at(1) });
    await db.insert(sightings).values({ catId: cat.id, originalKey: sampleSightingKey(3), publicKey: "photos/drawn.jpg", publicReady: true, state: "matched", createdAt: at(2) });
    expect((await getCatCard(cat.id))!.cat.photoUrl).toContain("real-milo.jpg");

    const [drawnOnly] = await db.insert(cats).values({ name: "Bagwis", areaName: "Brgy 1", status: "queued" }).returning();
    await db.insert(sightings).values({ catId: drawnOnly.id, originalKey: sampleSightingKey(4), publicKey: "photos/drawn-2.jpg", publicReady: true, state: "matched" });
    expect((await getCatCard(drawnOnly.id))!.cat.photoUrl).toContain("drawn-2.jpg");
  });
});

describe("the vet's list of what a caretaker says", () => {
  it("names each claim once when two reports say the same thing", async () => {
    await signInAs("vet");
    const [cat] = await db.insert(cats).values({ name: "Toothless", areaName: "Brgy 1", status: "queued" }).returning();
    for (const day of ["2026-11-11", "2026-11-12"]) {
      await db.insert(reports).values({ catId: cat.id, claim: "sick", source: "neighbour", status: "confirmed", reportedOn: day });
    }
    const [vet] = await db.select().from(users).where(eq(users.role, "vet"));
    const d = await listVetDashboard(vet.id);
    expect(d.checkCats.find((c) => c.id === cat.id)?.claims).toEqual(["sick"]);
  });
});
