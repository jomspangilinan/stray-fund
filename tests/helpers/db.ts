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
