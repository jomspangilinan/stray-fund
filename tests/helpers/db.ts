import { Pool } from "pg";

export function createTestPool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is not set");
  }
  return new Pool({ connectionString });
}

export async function closeTestPool(pool: Pool): Promise<void> {
  await pool.end();
}

/** Empties every table in the public schema, then reseeds guardrails. */
export async function truncateAll(): Promise<void> {
  const pool = createTestPool();
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    );
    if (rows.length === 0) return;
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    await pool.query(`truncate ${names} restart identity cascade`);
    // The migration seeds the guardrails singleton; restore it.
    await pool.query("insert into guardrails (id) values (1)");
  } finally {
    await pool.end();
  }
}
