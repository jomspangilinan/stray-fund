import { config } from "dotenv";
import { runWorkerLoops } from "../server/agent/worker";
import { closePool } from "../server/db/client";

// Local development only. In production the environment is already set and this file is absent.
config({ path: ".env.local", quiet: true });

async function main(): Promise<void> {
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`[worker] ${signal}: finishing the current wakeup, then exiting`);
      stop.abort();
    });
  }
  console.log("[worker] started");
  await runWorkerLoops({}, stop.signal);
  await closePool();
  console.log("[worker] stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[worker] crashed: ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  },
);
