import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { catAvatar } from "@/lib/avatar";
import { COLONY } from "@/lib/config";
import { db } from "./db/client";
import { agentActions, cats, donations, earTipFlags, guardrails, payouts, reports, sightings, users } from "./db/schema";
import { ensureDemoPersonas } from "./demoPersonas";
import { assertE2eFakesSafe, paypalIsLive } from "./e2e/guard";
import { SAMPLE_REASON } from "./demoPrivacy";
import { fuzzLocation } from "./location";
import { storeOriginal } from "./photos";
import { getStorage, newPublicKey } from "./storage";

/*
 * Sample data for a demo. It resets the database it is pointed at, so it refuses to run unless SEED_CONFIRM=yes,
 * in production as anywhere else, and it prints which host and database it will write before it writes.
 *
 * Every cat here is a real stray, photographed by the project's owner, with its photo in scripts/seed-photos (cropped to
 * the cat, metadata stripped). Coordinates are invented, near the colony's placeholder centre. There is no money: the
 * ledger starts empty, so every row on it is a real PayPal sandbox transaction made in the demo. Kislap and Milo wait for
 * funding. Their waiting days, Milo's open hurt report (with a drawn stand-in for the neighbour's photo, shown on the
 * caretaker's desk only) and the two neighbours' ear-tip answers are sample data for the demo story.
 */

export const SAMPLE_PREFIX = "SAMPLE-";

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefused";
  }
}

type Env = Record<string, string | undefined>;

/** Throws unless the person has said yes on purpose. Production is no different, and may not run with the test fakes on. */
export function assertSeedAllowed(env: Env = process.env): void {
  assertE2eFakesSafe(env);
  if (!env.DATABASE_URL) throw new SeedRefused("DATABASE_URL is not set, so there is no database to seed.");
  // The sample story leaves a confirmed booking with no deposit and a queued cat. On real PayPal credentials the
  // worker could start a real deposit for them, so the seed is for demos only.
  if (env.DEMO_MODE !== "true") throw new SeedRefused("Seeding is for demos only. Set DEMO_MODE=true to seed. Nothing was changed.");
  if (paypalIsLive(env)) throw new SeedRefused("Seeding is refused while PAYPAL_ENV is live: the worker could start a real deposit for the sample booking. Nothing was changed.");
  if (env.SEED_CONFIRM !== "yes") {
    throw new SeedRefused(
      "Seeding empties every table in the database first. Nothing was changed. To go ahead, run it again with SEED_CONFIRM=yes.",
    );
  }
}

const isSampleId = (id: string) => id.startsWith(SAMPLE_PREFIX) || id.startsWith("E2E-");

/**
 * Throws when the database holds a PayPal id that is not SAMPLE- or E2E-, unless SEED_WIPE_REAL=yes. Reads only.
 * A payout with no batch id yet is real, unless its action says "Sample data.", which is how the seed marks its own.
 */
export async function assertNoRealLedger(env: Env = process.env): Promise<void> {
  if (env.SEED_WIPE_REAL === "yes") return;
  const orders = await db.select({ id: donations.paypalOrderId }).from(donations);
  const batches = await db
    .select({ id: payouts.paypalPayoutBatchId, reason: agentActions.reason })
    .from(payouts)
    .innerJoin(agentActions, eq(payouts.actionId, agentActions.id));
  const realOrders = orders.filter((r) => !isSampleId(r.id)).length;
  const realBatches = batches.filter((r) => (r.id === null ? !r.reason.startsWith(SAMPLE_REASON) : !isSampleId(r.id))).length;
  const real = realOrders + realBatches;
  if (real > 0) {
    throw new SeedRefused(
      `This database holds ${real} PayPal id${real === 1 ? "" : "s"} that are not sample or test ids, so it looks like a real ledger. Seeding would empty it. Nothing was changed. If you really mean it, run again with SEED_WIPE_REAL=yes.`,
    );
  }
}

/** Host, port and database name of a connection string, with no user or password. */
export function describeTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
}

const day = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Pesos in the seeded rows follow the fake PayPal's stand-in fee: 2.9% plus PHP 15.00. */

type SeedCat = {
  key: string;
  name: string;
  sex: "female" | "male" | "unknown";
  status: string;
  pattern: string;
  colors: string[];
  markings: string;
  bio: string;
  flags?: string[];
  ageDays: number;
  /** Offsets from the invented centre, in thousandths of a degree. */
  at: [number, number];
  earTipped?: boolean | null;
  neuteredUnconfirmed?: boolean;
  queued?: boolean;
  /** A real cat's photo in scripts/seed-photos, published as its card photo. */
  photo?: string;
};

const SEED_CATS: SeedCat[] = [
  // The two waiting for funding. Kislap sleeps in the owner's garage.
  { key: "kislap", name: "Kislap", sex: "female", status: "queued", pattern: "tabby", colors: ["grey", "white"], markings: "Grey tabby kitten with a white chest.", bio: "Sleeps in a garage and is fed there every day.", ageDays: 12, at: [-4, 1], earTipped: false, queued: true, photo: "kislap.jpg" },
  { key: "milo", name: "Milo", sex: "male", status: "queued", pattern: "bicolor", colors: ["ginger", "white"], markings: "Mostly ginger, with a white chest and legs.", bio: "Sleeps stretched out on warm concrete.", ageDays: 9, at: [4, -5], earTipped: false, queued: true, photo: "milo.jpg" },
  // Spotted only. Sex unknown: nobody has checked.
  { key: "leo", name: "Leo", sex: "unknown", status: "spotted", pattern: "tabby", colors: ["ginger"], markings: "Ginger tabby kitten with white paws.", bio: "Crouches on a step and watches people walk by.", ageDays: 2, at: [-3, 3], photo: "leo.jpg" },
  { key: "oliver", name: "Oliver", sex: "unknown", status: "spotted", pattern: "tabby", colors: ["ginger"], markings: "Pale ginger tabby kitten.", bio: "Climbs onto anything warm, laptops included.", ageDays: 5, at: [2, 5], photo: "oliver.jpg" },
  { key: "lily", name: "Lily", sex: "unknown", status: "spotted", pattern: "tabby", colors: ["grey", "white"], markings: "Grey tabby with a white chest and legs.", bio: "Sits beside Oreo and watches.", ageDays: 4, at: [-1, 6], photo: "lily.jpg" },
  { key: "oreo", name: "Oreo", sex: "unknown", status: "spotted", pattern: "tuxedo", colors: ["black", "white"], markings: "Black kitten with white paws and a white chin.", bio: "Stays close to Lily.", ageDays: 4, at: [-2, 7], photo: "oreo.jpg" },
  { key: "teddy", name: "Teddy", sex: "unknown", status: "spotted", pattern: "bicolor", colors: ["black", "white"], markings: "Mostly black kitten with a white face, chest and paws.", bio: "Looks straight up at whoever stops.", ageDays: 2, at: [5, -2], photo: "teddy.jpg" },
];

/**
 * The stand-in for a neighbour's photo: a flat drawing of a cat's head, no text, no real animal. Stored under a key the
 * desk is allowed to serve in the demo (see isSampleSightingKey).
 */
export const sampleSightingKey = (n: number): string => `originals/00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}.jpg`;

async function sampleDrawing(): Promise<Buffer> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">` +
    `<rect width="640" height="480" fill="#e9efe9"/><polygon points="220,190 250,90 300,160" fill="#8a8f86"/><polygon points="420,190 390,90 340,160" fill="#8a8f86"/>` +
    `<ellipse cx="320" cy="270" rx="125" ry="105" fill="#9da197"/><ellipse cx="275" cy="255" rx="14" ry="20" fill="#35423b"/><ellipse cx="365" cy="255" rx="14" ry="20" fill="#35423b"/>` +
    `<polygon points="308,292 332,292 320,306" fill="#d79a9a"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

const SEED_DONORS = ["demo_ate_lorna", "demo_kuya_ben", "demo_lola_nena", "demo_tito_jun"] as const;

/** Resets the database the app is pointed at and writes the sample story. Caller has checked assertSeedAllowed. */
export async function seed(env: Env = process.env): Promise<{ cats: number; donors: number }> {
  await assertNoRealLedger(env);
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
    const names = (rows as { tablename: string }[]).map((r) => `"${r.tablename}"`).join(", ");
    await tx.execute(sql.raw(`truncate ${names} restart identity cascade`));
    await tx.insert(guardrails).values({ id: 1 });
  });

  await ensureDemoPersonas();
  const byName = async (username: string) => (await db.select().from(users).where(sql`${users.username} = ${username}`))[0];
  const neighbour = await byName("demo_neighbour");
  const donors = await db
    .insert(users)
    .values(SEED_DONORS.map((username) => ({ username, role: "donor" })))
    .returning();
  const donor = Object.fromEntries(donors.map((d) => [d.username, d]));

  await db.transaction(async (tx) => {
    const cat: Record<string, typeof cats.$inferSelect> = {};
    for (const c of SEED_CATS) {
      const exact = { lat: COLONY.centre.lat + c.at[0] / 1000, lng: COLONY.centre.lng + c.at[1] / 1000 };
      const fuzzed = fuzzLocation(exact.lat, exact.lng);
      const [row] = await tx
        .insert(cats)
        .values({
          name: c.name,
          nameLocked: true,
          sex: c.sex,
          status: c.status,
          earTipped: c.earTipped ?? null,
          neuteredUnconfirmed: c.neuteredUnconfirmed ?? false,
          flags: c.flags ?? [],
          coat: { colors: c.colors, markings: c.markings },
          coatPattern: c.pattern,
          avatar: catAvatar({ colors: c.colors, markings: c.markings }, c.pattern),
          areaName: COLONY.area_name,
          exactLat: exact.lat,
          exactLng: exact.lng,
          fuzzedLat: fuzzed.lat,
          fuzzedLng: fuzzed.lng,
          locationApproximate: false,
          bio: c.bio,
          queuedAt: c.queued ? day(c.ageDays - 1) : null,
          createdAt: day(c.ageDays),
        })
        .returning();
      cat[c.key] = row;
      if (c.photo) {
        // The real photo, private as the original and public as the card's photo, from a first sighting.
        const jpeg = await readFile(path.join(process.cwd(), "scripts", "seed-photos", c.photo));
        const { key: originalKey } = await storeOriginal(jpeg);
        const publicKey = newPublicKey();
        await getStorage().putPublic(publicKey, jpeg, "image/jpeg");
        await tx.insert(sightings).values({
          catId: row.id,
          originalKey,
          publicKey,
          publicReady: true,
          takenAt: day(c.ageDays),
          caughtByUserId: neighbour.id,
          exactLat: exact.lat,
          exactLng: exact.lng,
          state: "new_cat",
          createdAt: day(c.ageDays),
        });
      }
    }

    // Two neighbours' answers behind Kislap's ear-tip story. Private, like all of them.
    await tx.insert(earTipFlags).values([
      { catId: cat.kislap.id, userId: neighbour.id, value: "no" },
      { catId: cat.kislap.id, userId: donor.demo_kuya_ben.id, value: "no" },
    ]);

    // ---------------- the report story. Invented notes, no names or places. The treasurer has decided nothing yet:
    // confirming the open report is what wakes it, and its answer comes from a real run.
    const drawing = await sampleDrawing();
    const reportAbout = async (n: number, catKey: string, reporter: typeof neighbour, claim: string, note: string, ago: number, rest: Partial<typeof reports.$inferInsert>) => {
      const [sighting] = await tx
        .insert(sightings)
        .values({
          catId: cat[catKey].id,
          originalKey: sampleSightingKey(n),
          publicReady: false,
          takenAt: day(ago),
          caughtByUserId: reporter.id,
          matchConfidence: 0.9,
          exactLat: cat[catKey].exactLat,
          exactLng: cat[catKey].exactLng,
          state: "matched",
          createdAt: day(ago),
        })
        .returning();
      await getStorage().putPrivate(sighting.originalKey, drawing, "image/jpeg");
      await tx.insert(reports).values({
        catId: cat[catKey].id,
        sightingId: sighting.id,
        claim,
        note,
        source: "neighbour",
        reporterId: reporter.id,
        sample: true,
        reportedOn: day(ago).toISOString().slice(0, 10),
        createdAt: day(ago),
        ...rest,
      });
    };
    // Open: a neighbour says Milo is hurt, so he is held and tops the desk.
    await reportAbout(1, "milo", neighbour, "injured", "Limping on the back left leg since this morning and will not put weight on it.", 0.1, {});
  });

  return { cats: SEED_CATS.length, donors: SEED_DONORS.length };
}
