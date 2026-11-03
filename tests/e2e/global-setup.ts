import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { appEnv, OUT_DIR } from "./env";

/** Empties the scratch database, then starts the worker the way production does, and stops only that worker afterwards. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = appEnv();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_%'",
    );
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    await pool.query(`truncate ${names} restart identity cascade`);
    await pool.query("insert into guardrails (id) values (1)");
  } finally {
    await pool.end();
  }

  const worker: ChildProcess = spawn("node_modules/.bin/tsx", ["src/worker/index.ts"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The worker did not start")), 30_000);
    worker.stdout!.on("data", (d: Buffer) => {
      process.stdout.write(`[worker] ${d}`);
      if (String(d).includes("[worker] started")) {
        clearTimeout(timer);
        worker.removeAllListeners("exit");
        resolve();
      }
    });
    worker.stderr!.on("data", (d: Buffer) => process.stderr.write(`[worker!] ${d}`));
    worker.once("exit", (code) => reject(new Error(`The worker exited early with code ${code}`)));
  });

  return async () => {
    if (worker.exitCode !== null) return;
    worker.removeAllListeners("exit");
    await new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      worker.kill("SIGTERM");
      setTimeout(() => worker.kill("SIGKILL"), 15_000).unref();
    });
  };
}
