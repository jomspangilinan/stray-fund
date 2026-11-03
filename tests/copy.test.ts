import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The app thanks people and invites them. It never scolds, counts a loss, or sets a clock.
 * This reads the neighbour-facing source for words that would. Caretaker, vet and ledger screens may be
 * direct about money state, so they are left out. Field names in code are fine; only text people read is checked.
 */
const ROOT = path.join(__dirname, "..", "src");
const NEIGHBOUR = [
  "app/page.tsx",
  "app/cats",
  "app/helped",
  "app/missions",
  "app/spot",
  "components/CatDetail.tsx",
  "components/CatRow.tsx",
  "components/GoalCard.tsx",
  "components/MissionList.tsx",
  "components/SpotFlow.tsx",
  "components/SpotReveal.tsx",
  "components/ScanChecklist.tsx",
  "components/CelebrationNote.tsx",
  "lib/missions.ts",
  "lib/spotCopy.ts",
  "lib/scanSteps.ts",
  "server/milestones.ts",
];
const BAD = /\b(overdue|missed|you missed|streak (lost|broken)|lost your|don't lose|expires?|expiring|countdown|hurry|running out|leaderboard|rank(ed|ing)?|only \d+ left|last chance|disappoint|failed)\b/i;

function files(p: string): string[] {
  const full = path.join(ROOT, p);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => path.join(d.parentPath, d.name));
}

/** String literals and JSX text only, not identifiers. */
function readable(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) out.push(m[2]);
  for (const m of src.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out.filter((t) => !t.includes("${") && /\s|^[A-Z]/.test(t));
}

describe("no-punishment copy", () => {
  for (const p of NEIGHBOUR) {
    it(`${p} has no scolding, loss or pressure words`, () => {
      for (const f of files(p)) {
        const bad = readable(readFileSync(f, "utf8")).filter((t) => BAD.test(t));
        expect(bad, f).toEqual([]);
      }
    });
  }

  it("shows a vaccine that is due as calm 'Due now'", () => {
    const src = readFileSync(path.join(ROOT, "components/CatDetail.tsx"), "utf8");
    expect(src).toContain("Due now, since");
    expect(src).not.toMatch(/"Overdue/);
    expect(src).not.toMatch(/text-danger/);
  });
});
