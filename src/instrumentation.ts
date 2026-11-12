import { assertBootSafe } from "@/server/e2e/guard";
import { judgeGateWarning } from "@/server/judgeGate";

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
  // Once, from the Node.js server only, so the warning is not printed again by the edge runtime.
  const gate = process.env.NEXT_RUNTIME === "nodejs" ? judgeGateWarning() : null;
  if (gate) console.warn(`[boot] ${gate}`);
}
