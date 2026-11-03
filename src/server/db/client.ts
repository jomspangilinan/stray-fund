import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { getPool } from "./pool";

export { closePool } from "./pool";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let instance: Db | undefined;
let instancePool: ReturnType<typeof getPool> | undefined;

function getDb(): Db {
  const pool = getPool();
  // closePool() creates a fresh pool on next use, so rebuild the wrapper too.
  if (!instance || instancePool !== pool) {
    instance = drizzle(pool, { schema });
    instancePool = pool;
  }
  return instance;
}

/** Lazily bound so DATABASE_URL is read on first use, not at import. */
export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/** Arbitrary constant key for the single colony-wide money lock. */
const COLONY_LOCK_KEY = 7_301_001;

/** Takes the colony advisory lock until the transaction ends. Safe to call twice. */
export async function lockColony(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${COLONY_LOCK_KEY})`);
}

/** Runs fn in a transaction holding the colony advisory lock until commit. */
export async function withColonyLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await lockColony(tx);
    return fn(tx);
  });
}
