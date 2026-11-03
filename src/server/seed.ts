import { sql } from "drizzle-orm";
import { catAvatar } from "@/lib/avatar";
import { COLONY } from "@/lib/config";
import { db } from "./db/client";
import {
  agentActions,
  allocations,
  bookings,
  cats,
  donations,
  earTipFlags,
  guardrails,
  payouts,
  receipts,
  treatments,
  users,
} from "./db/schema";
import { DEMO_CLINIC_NAME, ensureDemoPersonas } from "./demoPersonas";
import { assertE2eFakesSafe } from "./e2e/guard";
import { fuzzLocation } from "./location";

/*
 * Sample data for a demo. It resets the database it is pointed at, so it refuses to run unless SEED_CONFIRM=yes,
 * in production as anywhere else, and it prints which host and database it will write before it writes.
 *
 * Everything here is invented. Coordinates are near the colony's placeholder centre. Money rows are sample data and
 * say so: every PayPal id starts with SAMPLE-, and every sentence the treasurer "wrote" starts with "Sample data."
 * No id here was ever issued by PayPal. No cat has a photo, because there is no licensed photo to use, so every
 * card shows its look-alike. The totals add up: the Proof page balances on the seeded rows alone.
 */

export const SAMPLE_PREFIX = "SAMPLE-";
export const SAMPLE_REASON = "Sample data. ";

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
  if (env.SEED_CONFIRM !== "yes") {
    throw new SeedRefused(
      "Seeding empties every table in the database first. Nothing was changed. To go ahead, run it again with SEED_CONFIRM=yes.",
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
const feeFor = (gross: number) => Math.round(gross * 0.029) + 1500;

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
};

const SEED_CATS: SeedCat[] = [
  { key: "tala", name: "Tala", sex: "unknown", status: "spotted", pattern: "tabby", colors: ["grey"], markings: "Grey tabby with a ringed tail.", bio: "Shy at first, then a loud purrer by the bakery wall.", ageDays: 1, at: [2, -3] },
  { key: "mingming", name: "Mingming", sex: "female", status: "queued", pattern: "calico", colors: ["white", "ginger", "black"], markings: "Calico with a ginger patch over one eye.", bio: "Waits at the same step every morning.", ageDays: 12, at: [-4, 1], earTipped: false, queued: true },
  { key: "kiko", name: "Kiko", sex: "male", status: "funded", pattern: "bicolor", colors: ["black", "white"], markings: "Black with a white bib and socks.", bio: "Easy to pick out by his white socks.", ageDays: 20, at: [5, 4], earTipped: false },
  { key: "bagwis", name: "Bagwis", sex: "female", status: "booked", pattern: "tabby", colors: ["ginger"], markings: "Ginger tabby, thin stripes.", bio: "Climbs the fence to greet the feeder.", flags: ["pregnant"], ageDays: 26, at: [-2, -6], earTipped: false },
  { key: "luna", name: "Luna", sex: "female", status: "in_care", pattern: "tuxedo", colors: ["black", "white"], markings: "Tuxedo with a white blaze.", bio: "Calm, and always the last to leave the food.", ageDays: 34, at: [7, -1], earTipped: false },
  { key: "puso", name: "Puso", sex: "male", status: "neutered", pattern: "solid", colors: ["grey"], markings: "Solid grey with a flat-cut left ear.", bio: "Neighbours say his ear is already tipped.", ageDays: 15, at: [-6, 5], earTipped: true, neuteredUnconfirmed: true },
  { key: "tisay", name: "Tisay", sex: "female", status: "adoptable", pattern: "colorpoint", colors: ["cream", "brown"], markings: "Cream coat with brown points.", bio: "Already neutered when found. A caretaker confirmed her tipped ear.", ageDays: 48, at: [3, 7], earTipped: true },
  { key: "biscoy", name: "Biscoy", sex: "male", status: "adopted", pattern: "solid", colors: ["ginger"], markings: "Plain ginger coat.", bio: "Neutered through the fund, then taken in by a family.", ageDays: 70, at: [-8, -2], earTipped: true },
];

const SEED_DONORS = ["demo_ate_lorna", "demo_kuya_ben", "demo_lola_nena", "demo_tito_jun"] as const;

/** Resets the database the app is pointed at and writes the sample story. Caller has checked assertSeedAllowed. */
export async function seed(): Promise<{ cats: number; donors: number }> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
    const names = (rows as { tablename: string }[]).map((r) => `"${r.tablename}"`).join(", ");
    await tx.execute(sql.raw(`truncate ${names} restart identity cascade`));
    await tx.insert(guardrails).values({ id: 1 });
  });

  await ensureDemoPersonas();
  const byName = async (username: string) => (await db.select().from(users).where(sql`${users.username} = ${username}`))[0];
  const neighbour = await byName("demo_neighbour");
  const caretaker = await byName("demo_caretaker");
  const vet = await byName("demo_vet");
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
    }

    // Neighbours' answers behind the two ear-tip stories. Private, like all of them.
    await tx.insert(earTipFlags).values([
      { catId: cat.mingming.id, userId: neighbour.id, value: "no" },
      { catId: cat.mingming.id, userId: donor.demo_kuya_ben.id, value: "no" },
      { catId: cat.puso.id, userId: donor.demo_ate_lorna.id, value: "yes" },
      { catId: cat.puso.id, userId: donor.demo_lola_nena.id, value: "yes" },
    ]);

    // ---------------- sample donations. Net = gross - fee.
    const gifts = [
      { id: 1, user: donor.demo_kuya_ben, gross: 150_000, ago: 40 },
      { id: 2, user: donor.demo_ate_lorna, gross: 300_000, ago: 33 },
      { id: 3, user: donor.demo_lola_nena, gross: 50_000, ago: 28 },
      { id: 4, user: donor.demo_tito_jun, gross: 200_000, ago: 21 },
      { id: 5, user: neighbour, gross: 150_000, ago: 14 },
    ];
    const gift: Record<number, typeof donations.$inferSelect> = {};
    for (const g of gifts) {
      const fee = feeFor(g.gross);
      const [row] = await tx
        .insert(donations)
        .values({
          userId: g.user.id,
          gross: g.gross,
          paypalFee: fee,
          net: g.gross - fee,
          currency: "PHP",
          paypalOrderId: `${SAMPLE_PREFIX}ORDER-${g.id}`,
          paypalCaptureId: `${SAMPLE_PREFIX}CAPTURE-${g.id}`,
          status: "captured",
          createdAt: day(g.ago),
        })
        .returning();
      gift[g.id] = row;
    }

    // ---------------- money set aside for each funded cat: the oldest gifts first, as the real pool does
    const PACKAGE = 150_000;
    const DEPOSIT = 45_000;
    const BALANCE = 75_000;
    const RECEIPT_TOTAL = DEPOSIT + BALANCE;
    const SURPLUS = PACKAGE - RECEIPT_TOTAL;
    const setAside = async (catKey: string, draws: [number, number][], ago: number) => {
      for (const [giftId, amount] of draws) {
        await tx.insert(allocations).values({ donationId: gift[giftId].id, catId: cat[catKey].id, purpose: "vet", amount, createdAt: day(ago) });
      }
      await tx.insert(agentActions).values({
        action: "fund_cat",
        reason: `${SAMPLE_REASON}${cat[catKey].name} was next in line and the fund could cover the care.`,
        amount: PACKAGE,
        status: "done",
        inputs: { catId: cat[catKey].id, sample: true },
        createdAt: day(ago),
      });
    };
    await setAside("biscoy", [[1, 144_150], [2, 5_850]], 38);
    await setAside("luna", [[2, PACKAGE]], 30);
    await setAside("kiko", [[2, 133_950], [3, 16_050]], 22);
    await setAside("bagwis", [[3, 31_000], [4, 119_000]], 18);
    // Biscoy's receipt came in under the package, so the surplus went back to the pool, newest gift first.
    await tx.insert(allocations).values([
      { donationId: gift[2].id, catId: cat.biscoy.id, purpose: "vet", amount: -5_850, createdAt: day(31) },
      { donationId: gift[1].id, catId: cat.biscoy.id, purpose: "vet", amount: -(SURPLUS - 5_850), createdAt: day(31) },
    ]);

    // ---------------- vet bookings and the payouts that went out. Ids say SAMPLE; none came from PayPal.
    const book = async (catKey: string, status: string, scheduledAgo: number) => {
      const [b] = await tx
        .insert(bookings)
        .values({ catId: cat[catKey].id, vetId: vet.id, packagePrice: PACKAGE, status, scheduledFor: day(scheduledAgo), createdAt: new Date(Math.min(Date.now(), day(scheduledAgo + 1).getTime())) })
        .returning();
      return b;
    };
    let batchNo = 0;
    const pay = async (b: typeof bookings.$inferSelect, kind: "deposit" | "balance", amount: number, fee: number, ago: number, receiptId?: string) => {
      batchNo += 1;
      const batch = `${SAMPLE_PREFIX}BATCH-${batchNo}`;
      const [action] = await tx
        .insert(agentActions)
        .values({
          action: `payout_${kind}`,
          reason: `${SAMPLE_REASON}${kind === "deposit" ? "The vet visit was confirmed, so the deposit went out." : "The receipt was checked and the deposit was paid, so the balance went out."}`,
          amount,
          status: "succeeded",
          paypalRef: batch,
          approvedBy: caretaker.id,
          inputs: { bookingId: b.id, catId: b.catId, sample: true },
          createdAt: day(ago),
        })
        .returning();
      await tx.insert(payouts).values({
        catId: b.catId,
        bookingId: b.id,
        payeeUserId: vet.id,
        amount,
        fee,
        kind,
        paypalPayoutBatchId: batch,
        paypalItemId: `${SAMPLE_PREFIX}ITEM-${batchNo}`,
        receiptId,
        actionId: action.id,
        status: "succeeded",
        attempts: 1,
        lastAttemptAt: day(ago),
        createdAt: day(ago),
      });
    };

    const adoptedBooking = await book("biscoy", "completed", 36);
    await pay(adoptedBooking, "deposit", DEPOSIT, 900, 36);
    const [receipt] = await tx
      .insert(receipts)
      .values({
        bookingId: adoptedBooking.id,
        fileKey: `originals/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(11)}1.jpg`,
        sha256: "0".repeat(63) + "1",
        parsed: {
          clinic: DEMO_CLINIC_NAME,
          date: day(31).toISOString().slice(0, 10),
          total_centavos: RECEIPT_TOTAL,
          currency: "PHP",
          receipt_number: "SAMPLE-RECEIPT-1",
          cat_name: null,
          items: ["Spay or neuter surgery", "Anti-rabies vaccine", "Deworming"],
          tamper_signs: [],
        },
        verification: "verified",
        reasons: [],
        createdAt: day(31),
      })
      .returning();
    await pay(adoptedBooking, "balance", BALANCE, 1_500, 30, receipt.id);
    const treated = day(31).toISOString().slice(0, 10);
    const dateIn = (add: { months?: number; years?: number }) => {
      const d = new Date(`${treated}T00:00:00Z`);
      d.setUTCFullYear(d.getUTCFullYear() + (add.years ?? 0));
      d.setUTCMonth(d.getUTCMonth() + (add.months ?? 0));
      return d.toISOString().slice(0, 10);
    };
    const common = { catId: cat.biscoy.id, vetId: vet.id, receiptId: receipt.id, date: treated };
    await tx.insert(treatments).values([
      { ...common, type: "neuter", product: "Spay or neuter surgery" },
      { ...common, type: "vaccine", product: "Anti-rabies vaccine", nextDue: dateIn({ years: 1 }) },
      { ...common, type: "deworming", product: "Deworming", nextDue: dateIn({ months: 3 }) },
    ]);

    const inCareBooking = await book("luna", "confirmed", 25);
    await pay(inCareBooking, "deposit", DEPOSIT, 900, 25);
    await book("bagwis", "confirmed", -2);
  });

  return { cats: SEED_CATS.length, donors: SEED_DONORS.length };
}
