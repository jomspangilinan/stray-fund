import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { closePool, db } from "../src/server/db/client";
import { cats, sightings, users } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { setAiForTests } from "../src/server/ai/client";
import { SESSION_COOKIE, signSession } from "../src/server/session";
import { buildReveal, type RevealInput } from "../src/server/spotReveal";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
  }),
}));

import { POST as spotPost } from "../src/app/api/spot/route";

const cat = (patch: Partial<NonNullable<RevealInput["cat"]>> = {}): NonNullable<RevealInput["cat"]> => ({
  name: "Pepita",
  status: "queued",
  sex: "unknown",
  coatPattern: "tortoiseshell",
  avatar: { pattern: "tortoiseshell", base: "black", accent: "ginger" },
  flags: ["pregnant"],
  ...patch,
});
const sighting = (patch: Partial<RevealInput["sighting"]> = {}): RevealInput["sighting"] => ({
  publicKey: null,
  publicReady: false,
  requestedSex: null,
  coatSaysFemale: false,
  ...patch,
});

describe("buildReveal", () => {
  it("shows labels for a new cat, and only labels", () => {
    const r = buildReveal({ state: "new_cat", cat: cat(), sighting: sighting() });
    expect(r).toEqual({
      name: "Pepita",
      avatar: { pattern: "tortoiseshell", base: "black", accent: "ginger" },
      coat: "Tortoiseshell",
      yourEarTip: null,
      flags: ["Pregnant"],
      statusLabel: "Waiting for funding",
      probablyFemale: false,
      needsFunding: true,
      photoUrl: null,
    });
  });

  it("says probably female only when the coat rule set the sex", () => {
    const fromCoat = buildReveal({
      state: "new_cat",
      cat: cat({ sex: "female" }),
      sighting: sighting({ coatSaysFemale: true }),
    });
    expect(fromCoat?.probablyFemale).toBe(true);
    // The finder said female, so the server did not infer it.
    const fromFinder = buildReveal({
      state: "new_cat",
      cat: cat({ sex: "female" }),
      sighting: sighting({ coatSaysFemale: true, requestedSex: "female" }),
    });
    expect(fromFinder?.probablyFemale).toBe(false);
    // A cat we already knew keeps whatever sex it had; no claim from this photo.
    const matched = buildReveal({
      state: "matched",
      cat: cat({ sex: "female" }),
      sighting: sighting({ coatSaysFemale: true }),
    });
    expect(matched?.probablyFemale).toBe(false);
    // The coat rule did not fire.
    expect(buildReveal({ state: "new_cat", cat: cat({ sex: "female" }), sighting: sighting() })?.probablyFemale).toBe(false);
  });

  it("makes no confident claims when a caretaker must look", () => {
    const r = buildReveal({ state: "needs_review", cat: cat(), sighting: sighting({ publicKey: "photos/x.jpg", publicReady: true }) });
    expect(r).toEqual({
      name: null,
      avatar: null,
      coat: null,
      yourEarTip: null,
      flags: [],
      statusLabel: "Waiting for a caretaker",
      probablyFemale: false,
      needsFunding: false,
      photoUrl: null,
    });
  });

  it("only ever passes on a fixed-palette look-alike, and a neutral one while it is not ready", () => {
    const hostile = buildReveal({ state: "new_cat", cat: cat({ avatar: { pattern: "tabby", base: "<script>", accent: "ginger", extra: "x" } }), sighting: sighting() });
    expect(hostile?.avatar).toEqual({ pattern: "unknown", base: "grey", accent: "cream" });
    expect(buildReveal({ state: "matched", cat: cat({ avatar: null }), sighting: sighting() })?.avatar).toEqual({ pattern: "unknown", base: "grey", accent: "cream" });
  });

  it("has no reveal for a rejected or saved-for-later photo", () => {
    expect(buildReveal({ state: "rejected", cat: null, sighting: sighting() })).toBeNull();
    expect(buildReveal({ state: "queued_for_ai", cat: null, sighting: sighting() })).toBeNull();
    expect(buildReveal({ state: "new_cat", cat: null, sighting: sighting() })).toBeNull();
  });

  it("uses the public photo only when it is ready", () => {
    const ready = buildReveal({ state: "matched", cat: cat({ status: "in_care" }), sighting: sighting({ publicKey: "photos/a.jpg", publicReady: true }) });
    expect(ready?.photoUrl).toContain("photos/a.jpg");
    const notReady = buildReveal({ state: "matched", cat: cat(), sighting: sighting({ publicKey: "photos/a.jpg", publicReady: false }) });
    expect(notReady?.photoUrl).toBeNull();
    expect(ready?.needsFunding).toBe(false);
  });

  it("never says No ear-tip seen, and shows only the person's own answer", () => {
    const none = buildReveal({ state: "matched", cat: cat(), sighting: sighting() });
    expect(none?.yourEarTip).toBeNull();
    const mine = buildReveal({ state: "matched", cat: cat(), sighting: sighting(), yourEarTip: "no" });
    expect(mine?.yourEarTip).toBe("no");
    expect(JSON.stringify([none, mine])).not.toMatch(/No ear-tip seen|Ear-tipped|verified/i);
  });
});

const ASSESS = {
  is_cat: true,
  cat_visible_quality: "good",
  reject_reason: "none",
  coat_pattern: "calico",
  colors: ["orange", "SECRET-COLOUR"],
  markings: "SECRET-MARKINGS",
  flags: { kitten: false, pregnant: false, injured: false, sick: false },
  probably_female_by_coat: true,
  suggested_name: "Pepita",
  short_bio: "SECRET-BIO",
  sensitive_regions: [] as unknown[],
};

beforeEach(async () => {
  await truncateAll();
  jar.clear();
  setAiForTests(async () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(ASSESS) }],
  }));
});
afterAll(closePool);

describe("POST /api/spot reveal", () => {
  async function signIn() {
    const [u] = await db.insert(users).values({ username: `rv_${Date.now()}`, role: "donor" }).returning();
    jar.set(SESSION_COOKIE, await signSession({ userId: u.id, role: "donor", username: u.username }));
  }
  async function post(earTip?: string) {
    const f = new FormData();
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 90, b: 50 } } }).jpeg().toBuffer();
    f.set("photo", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "cat.jpg");
    f.set("lat", "10.123456");
    f.set("lng", "120.654321");
    if (earTip) f.set("earTip", earTip);
    return spotPost(new Request("http://localhost/api/spot", { method: "POST", body: f }));
  }

  it("answers with a whitelisted reveal and nothing from the assessment", async () => {
    await signIn();
    const res = await post();
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["catId", "message", "reveal", "sightingId", "state"]);
    expect(json.state).toBe("new_cat");
    const reveal = json.reveal as Record<string, unknown>;
    expect(Object.keys(reveal).sort()).toEqual([
      "avatar",
      "coat",
      "flags",
      "name",
      "needsFunding",
      "photoUrl",
      "probablyFemale",
      "statusLabel",
      "yourEarTip",
    ]);
    expect(reveal).toMatchObject({
      name: "Pepita",
      avatar: { pattern: "calico" },
      coat: "Calico",
      yourEarTip: null,
      probablyFemale: true,
      // The AI no longer queues a cat. People's ear-tip answers do.
      needsFunding: false,
    });
    expect(String(reveal.photoUrl)).toMatch(/photos\//);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/SECRET|10\.1234|120\.6543|originals\/|confidence|exact|fuzzed|assessment/i);
    const [row] = await db.select().from(sightings);
    expect(row.requestedSex).toBeNull();
    expect((await db.select().from(cats))[0].sex).toBe("female");
  });

  it("shows the finder their own ear-tip answer, labelled as theirs, and queues nothing on one answer", async () => {
    await signIn();
    const json = (await (await post("no")).json()) as { reveal: { yourEarTip: string; statusLabel: string; needsFunding: boolean } };
    expect(json.reveal.yourEarTip).toBe("no");
    expect(json.reveal.needsFunding).toBe(false);
    expect((await db.select().from(cats))[0].status).toBe("spotted");
    const [row] = await db.select().from(sightings);
    expect(row.requestedEarTip).toBe("no");
  });

  it("refuses an ear-tip answer that is not yes, no or unsure", async () => {
    await signIn();
    expect((await post("maybe")).status).toBe(400);
  });

  it("gives a null reveal when the photo is saved for later", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setAiForTests(async () => {
      throw new Error("down");
    });
    await signIn();
    const json = (await (await post()).json()) as Record<string, unknown>;
    expect(json.state).toBe("queued_for_ai");
    expect(json.reveal).toBeNull();
  });
});
