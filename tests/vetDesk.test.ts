import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/vet" }));

import { VetDesk } from "../src/components/VetDesk";
import { SESSION_COOKIE, signSession, type Role } from "../src/server/session";

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
