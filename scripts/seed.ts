import { config } from "dotenv";
import { closePool } from "../src/server/db/client";
import { assertNoRealLedger, assertSeedAllowed, describeTarget, seed, SeedRefused } from "../src/server/seed";

// Local development only, like the worker. In production the environment is already set.
config({ path: ".env.local", quiet: true });

async function main(): Promise<void> {
  assertSeedAllowed();
  await assertNoRealLedger();
  const target = describeTarget(process.env.DATABASE_URL!);
  console.log(`Seeding ${target} (NODE_ENV=${process.env.NODE_ENV ?? "unset"}). Every table there is emptied first.`);
  const done = await seed();
  await closePool();
  console.log(`Done: ${done.cats} cats and ${done.donors} donors, plus the demo neighbour, caretaker and vet. Money rows are sample data.`);
}

main().then(
  () => process.exit(0),
  async (e) => {
    console.error(e instanceof SeedRefused ? e.message : `Seed failed: ${e instanceof Error ? e.name : typeof e}`);
    if (!(e instanceof SeedRefused) && e instanceof Error) console.error(e.message);
    await closePool().catch(() => {});
    process.exit(1);
  },
);
