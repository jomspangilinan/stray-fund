import { describe, expect, it } from "vitest";
import { MAX_MISSIONS, pickMissions, type MissionCat } from "../src/lib/missions";

const NOW = new Date("2026-11-10T04:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const cat = (patch: Partial<MissionCat> = {}): MissionCat => ({
  id: "c-" + Math.random().toString(36).slice(2),
  name: "Muning",
  status: "queued",
  flags: [],
  earTipped: false,
  earTipYes: 0,
  earTipNo: 0,
  answeredByMe: false,
  photoUrl: null,
  lastSeenAt: daysAgo(0),
  ...patch,
});

describe("pickMissions", () => {
  it("asks to find a waiting cat not sighted for 3 or more days, with the days in the detail", () => {
    const [m] = pickMissions([cat({ name: "Muning", lastSeenAt: daysAgo(4) })], NOW);
    expect(m).toMatchObject({ kind: "find", title: "Help find Muning", action: "spot" });
    expect(m.detail).toBe("Last seen 4 days ago.");
  });

  it("does not ask for a cat seen within the last 2 days", () => {
    expect(pickMissions([cat({ lastSeenAt: daysAgo(2) })], NOW)).toEqual([]);
    expect(pickMissions([cat({ lastSeenAt: daysAgo(3) })], NOW)).toHaveLength(1);
  });

  it("names a pregnant or injured flag, and no other flag", () => {
    const [a] = pickMissions([cat({ lastSeenAt: daysAgo(5), flags: ["Pregnant"] })], NOW);
    expect(a.detail).toMatch(/pregnant/i);
    const [b] = pickMissions([cat({ lastSeenAt: daysAgo(5), flags: ["Injured", "Sick"] })], NOW);
    expect(b.detail).toMatch(/injured/i);
    expect(b.detail).not.toMatch(/sick/i);
    const [c] = pickMissions([cat({ lastSeenAt: daysAgo(5), flags: ["Kitten"] })], NOW);
    expect(c.detail).not.toMatch(/kitten/i);
  });

  it("never words a mission as a failure or a blame", () => {
    const all = pickMissions(
      [
        cat({ lastSeenAt: daysAgo(9), flags: ["Injured"] }),
        cat({ status: "spotted", earTipped: null }),
        cat({ status: "adoptable" }),
      ],
      NOW,
    );
    expect(JSON.stringify(all)).not.toMatch(/missing|overdue|missed|late|lost|failed|urgent|hurry|only/i);
  });

  it("asks a neighbour to confirm the ear-tip of a spotted cat, and opens its card", () => {
    const [m] = pickMissions([cat({ name: "Kuting", status: "spotted", earTipped: null })], NOW);
    expect(m).toMatchObject({ kind: "ear", title: "Confirm Kuting's ear-tip", action: "card" });
  });

  it("still asks while there is one answer, and stops at two matching answers", () => {
    const base = { status: "spotted", earTipped: null };
    expect(pickMissions([cat({ ...base, earTipNo: 1 })], NOW)).toHaveLength(1);
    expect(pickMissions([cat({ ...base, earTipYes: 1 })], NOW)).toHaveLength(1);
    expect(pickMissions([cat({ ...base, earTipNo: 2 })], NOW)).toEqual([]);
    expect(pickMissions([cat({ ...base, earTipYes: 2 })], NOW)).toEqual([]);
  });

  it("leaves a disagreement to a caretaker", () => {
    expect(pickMissions([cat({ status: "spotted", earTipped: null, earTipYes: 1, earTipNo: 1 })], NOW)).toEqual([]);
  });

  it("does not ask someone who already answered for that cat", () => {
    expect(pickMissions([cat({ status: "spotted", earTipped: null, earTipNo: 1, answeredByMe: true })], NOW)).toEqual([]);
  });

  it("does not ask about a cat that is queued or already decided", () => {
    expect(pickMissions([cat({ status: "queued", earTipped: false })], NOW)).toEqual([]);
    expect(pickMissions([cat({ status: "spotted", earTipped: true })], NOW)).toEqual([]);
  });

  it("gives a cat one mission, the find one first", () => {
    const out = pickMissions([cat({ status: "spotted", earTipped: null, lastSeenAt: daysAgo(6) })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("find");
  });

  it("offers an adoptable cat a home, with a share action", () => {
    const [m] = pickMissions([cat({ name: "Mingming", status: "adoptable" })], NOW);
    expect(m).toMatchObject({ kind: "home", title: "Help Mingming find a home", action: "share" });
  });

  it("skips neutered, adopted and in-care cats", () => {
    const out = pickMissions(
      ["neutered", "adopted", "in_care"].map((status) => cat({ status, lastSeenAt: daysAgo(30), earTipped: null })),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("orders by need and caps at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => cat({ id: `a${i}`, name: `Cat${i}`, lastSeenAt: daysAgo(3 + i) }));
    const urgent = cat({ id: "inj", name: "Hurt", lastSeenAt: daysAgo(3), flags: ["Injured"] });
    const out = pickMissions([...many, cat({ id: "home", status: "adoptable" }), urgent], NOW);
    expect(out).toHaveLength(MAX_MISSIONS);
    expect(MAX_MISSIONS).toBe(5);
    expect(out[0].catId).toBe("inj");
    expect(out.at(-1)?.kind).not.toBe("home");
  });

  it("is stable for equal need", () => {
    const a = cat({ id: "a", name: "Amy", lastSeenAt: daysAgo(4) });
    const b = cat({ id: "b", name: "Ben", lastSeenAt: daysAgo(4) });
    expect(pickMissions([b, a], NOW).map((m) => m.catId)).toEqual(["a", "b"]);
  });

  it("carries only whitelisted fields", () => {
    const [m] = pickMissions([cat({ lastSeenAt: daysAgo(5), photoUrl: "/p.jpg" })], NOW);
    expect(Object.keys(m).sort()).toEqual(["action", "catId", "detail", "kind", "photoUrl", "title"]);
  });

  it("clears a mission once a new sighting is in the data", () => {
    const stale = cat({ id: "x", lastSeenAt: daysAgo(5) });
    expect(pickMissions([stale], NOW)).toHaveLength(1);
    expect(pickMissions([{ ...stale, lastSeenAt: daysAgo(0) }], NOW)).toEqual([]);
  });
});
