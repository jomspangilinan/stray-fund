/*
 * E2E_FAKES swaps PayPal and the AI for local fakes, at the seams that already exist: the orders gateway,
 * the payout gateway, the webhook check and AiTransport. Nothing else changes. It exists for the end-to-end
 * test and must never run where real money or real people are involved, so a production server refuses to
 * start with it set at all, whatever the value.
 */

type Env = Record<string, string | undefined>;

export class FakesInProduction extends Error {
  constructor() {
    super("E2E_FAKES must not be set when NODE_ENV is production. Unset it and start again.");
    this.name = "FakesInProduction";
  }
}

/** Throws when E2E_FAKES is set to anything at all on a production server. */
export function assertE2eFakesSafe(env: Env = process.env): void {
  if (env.NODE_ENV === "production" && env.E2E_FAKES !== undefined && env.E2E_FAKES !== "") {
    throw new FakesInProduction();
  }
}

/** True only for E2E_FAKES=true outside production. Every fake checks this, so none can be reached in production. */
export function e2eFakesEnabled(env: Env = process.env): boolean {
  assertE2eFakesSafe(env);
  return env.E2E_FAKES === "true";
}
