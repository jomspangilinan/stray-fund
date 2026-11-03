/**
 * Pacing for the wait after a photo is sent. These steps are generic on purpose: they say what the
 * check looks at, never what it found, so the screen cannot claim a result before the server answers.
 */
export const SCAN_STEPS = [
  "Looking for a cat",
  "Checking the coat",
  "Checking cats we know",
] as const;

export const STEP_MS = 1800;

/** The states a spot reply can have. Mirrors the server's, kept here so this file stays free of server code. */
export type ScanReplyState = "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";

/** True when the reply never ran the checks, so none of the steps were done. */
export const noChecksRan = (state?: ScanReplyState): boolean => state === "rejected" || state === "queued_for_ai";

export type ScanProgress = { done: number; active: number | null };

/**
 * How many steps are ticked, and which one is working. Before the response the last step never ticks and
 * stays active however long the wait runs. After the response every step is ticked.
 */
export function scanProgress(elapsedMs: number, responded: boolean, state?: ScanReplyState): ScanProgress {
  // A rejected or queued reply never ran the checks, so no step is ticked.
  if (responded && noChecksRan(state)) return { done: 0, active: null };
  if (responded) return { done: SCAN_STEPS.length, active: null };
  const last = SCAN_STEPS.length - 1;
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const at = Math.min(Math.floor(ms / STEP_MS), last);
  return { done: at, active: at };
}
