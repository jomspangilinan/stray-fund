import type { Avatar } from "./avatar";
import { DEVELOP_POLL_LIMIT_MS, DEVELOP_POLL_MS, DEVELOP_SOON_MS } from "./scanSteps";

/** What GET /api/spot/[id] answers for the person who took the photo. */
export type DevelopStatus = { developed: boolean; photoUrl: string | null; avatar: Avatar };

/** A status, null for a miss worth retrying (offline, 5xx), or "stop" when asking again cannot help (not ours, signed out). */
export type FetchStatus = () => Promise<DevelopStatus | null | "stop">;

export type PollOutcome = { kind: "developed"; status: DevelopStatus } | { kind: "timeout" } | { kind: "stopped" };

/** Waits `ms`, or less if aborted. Resolves either way, so the loop can check the signal. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/**
 * Asks every DEVELOP_POLL_MS until the photo is developed or DEVELOP_POLL_LIMIT_MS passes. `onSoon` fires once at
 * DEVELOP_SOON_MS, and polling carries on after it: a server-tier photo can take two minutes.
 */
export async function pollDeveloped(
  fetchStatus: FetchStatus,
  { signal, onSoon, onStatus }: { signal?: AbortSignal; onSoon?: () => void; onStatus?: (s: DevelopStatus) => void },
): Promise<PollOutcome> {
  const t0 = Date.now();
  let toldSoon = false;
  for (;;) {
    if (signal?.aborted) return { kind: "stopped" };
    let status: DevelopStatus | null | "stop" = null;
    try {
      status = await fetchStatus();
    } catch {
      status = null;
    }
    if (signal?.aborted || status === "stop") return { kind: "stopped" };
    if (status) {
      if (status.developed) return { kind: "developed", status };
      onStatus?.(status);
    }
    const elapsed = Date.now() - t0;
    if (!toldSoon && elapsed >= DEVELOP_SOON_MS) {
      toldSoon = true;
      onSoon?.();
    }
    if (elapsed >= DEVELOP_POLL_LIMIT_MS) return { kind: "timeout" };
    await wait(DEVELOP_POLL_MS, signal);
  }
}

/**
 * The two lines for a photo still developing. `card` rides on the photo and `yard` sits under the cat. Neither
 * says anything was checked: on this path nothing was.
 */
export function developLines({ developed, soon }: { developed: boolean; soon: boolean }): { card: string | null; yard: string } {
  if (developed) return { card: null, yard: "Your cat is in the yard." };
  if (soon) return { card: null, yard: "Your cat is in the yard. The photo will appear soon." };
  return { card: "Developing…", yard: "Your cat is in the yard." };
}
