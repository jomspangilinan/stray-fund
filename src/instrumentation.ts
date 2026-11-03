import { assertBootSafe } from "@/server/e2e/guard";

/**
 * Runs once when the server starts. A production server with E2E_FAKES set does not come up: the process
 * exits, so the host sees a failed start instead of a server that is up and answering every request with an error.
 */
export function register(): void {
  try {
    assertBootSafe();
  } catch (e) {
    console.error(`[boot] ${e instanceof Error ? e.message : "Refusing to start."}`);
    if (process.env.NEXT_RUNTIME === "nodejs") process.exit(1);
    throw e;
  }
}
