/*
 * A boot check for the judge gate switch. It imports nothing, so instrumentation can load it in any runtime.
 * JUDGE_GATE turns the gate on only when it is exactly "true" (see judge.ts); any other value leaves the app open,
 * so a typo such as "True" or "yes" would silently ungate production. This says so once at startup.
 */

type Env = Record<string, string | undefined>;

/** The warning to log, or null when JUDGE_GATE is unset, empty or exactly "true". Never contains JUDGE_PASSCODE. */
export function judgeGateWarning(env: Env = process.env): string | null {
  const value = env.JUDGE_GATE;
  if (value === undefined || value === "" || value === "true") return null;
  const passcode = env.JUDGE_PASSCODE;
  // A passcode pasted into the wrong variable must not reach the logs.
  const shown = passcode && value.includes(passcode) ? "a value that contains JUDGE_PASSCODE" : JSON.stringify(value.slice(0, 40));
  return `JUDGE_GATE is set to ${shown}; only the exact value true turns the judge gate on.`;
}
