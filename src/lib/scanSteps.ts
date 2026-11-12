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

/** Only the judges' AI path runs checks, so only it lists them. The public path shows no checklist at all. */
export const showChecklist = (aiPath: boolean): boolean => aiPath;

/** The first part of the capture animation, from the shutter to the card settled with its label. */
export const CAPTURE_TOTAL_MS = 1500;
/** How often the phone asks whether its photo is developed. */
export const DEVELOP_POLL_MS = 1500;
/** The photo is still welcome after this long, but the screen says it will appear soon. */
export const DEVELOP_SOON_MS = 45_000;
/** Server-tier photos publish 60 to 120 s after upload, so the phone keeps asking this long. */
export const DEVELOP_POLL_LIMIT_MS = 150_000;
