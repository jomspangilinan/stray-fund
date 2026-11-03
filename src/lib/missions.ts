/*
 * Missions are plain rules over public-safe cat data. No AI or person picks them: the order is a score
 * from how long a cat has waited and whether it is pregnant or injured. A new sighting changes the data,
 * so a completed spot clears its mission by itself.
 */

export type MissionCat = {
  id: string;
  name: string;
  status: string;
  /** Public flag labels, such as "Pregnant". */
  flags: string[];
  earTipped: boolean | null;
  photoUrl: string | null;
  lastSeenAt: Date;
};

export type MissionKind = "find" | "ear" | "home";
export type Mission = {
  kind: MissionKind;
  catId: string;
  title: string;
  detail: string;
  action: "spot" | "share";
  photoUrl: string | null;
};

export const MAX_MISSIONS = 5;
export const UNSEEN_DAYS = 3;

const WAITING = ["spotted", "queued", "funded", "booked"];
const DAY_MS = 86_400_000;

const dayWord = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

function urgency(flags: string[]): { score: number; word: string | null } {
  if (flags.includes("Injured")) return { score: 30, word: "injured" };
  if (flags.includes("Pregnant")) return { score: 25, word: "pregnant" };
  return { score: 0, word: null };
}

export function pickMissions(cats: MissionCat[], now: Date): Mission[] {
  const scored: { m: Mission; score: number; name: string; id: string }[] = [];
  for (const c of cats) {
    const days = Math.max(0, Math.floor((now.getTime() - c.lastSeenAt.getTime()) / DAY_MS));
    const waiting = WAITING.includes(c.status);
    const base = { catId: c.id, photoUrl: c.photoUrl };
    if (waiting && days >= UNSEEN_DAYS) {
      const u = urgency(c.flags);
      scored.push({
        m: {
          ...base,
          kind: "find",
          title: `Help find ${c.name}`,
          detail: `Last seen ${dayWord(days)} ago${u.word ? `, ${u.word}` : ""}.`,
          action: "spot",
        },
        score: 100 + u.score + Math.min(days, 30),
        name: c.name,
        id: c.id,
      });
    } else if (c.status === "spotted" && c.earTipped === null) {
      scored.push({
        m: {
          ...base,
          kind: "ear",
          title: `Get a clear ear photo of ${c.name}`,
          detail: "Shows if they are neutered.",
          action: "spot",
        },
        score: 60,
        name: c.name,
        id: c.id,
      });
    } else if (c.status === "adoptable") {
      scored.push({
        m: { ...base, kind: "home", title: `Help ${c.name} find a home`, detail: "Neutered and ready.", action: "share" },
        score: 40,
        name: c.name,
        id: c.id,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return scored.slice(0, MAX_MISSIONS).map((s) => s.m);
}
