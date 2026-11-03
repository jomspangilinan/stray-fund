/*
 * E2E_FAKES swaps PayPal and the AI for local fakes, at the seams that already exist: the orders gateway,
 * the payout gateway, the webhook check and AiTransport. Nothing else changes. It exists for the end-to-end
 * test and must never run where real money or real people are involved, so a production server refuses to
 * start with it set at all, whatever the value. The same goes for any process pointed at live PayPal, because the worker
 * runs under tsx and may have no NODE_ENV at all.
 */

type Env = Record<string, string | undefined>;

export class FakesInProduction extends Error {
  constructor() {
    super("E2E_FAKES must not be set when NODE_ENV is production or PAYPAL_ENV is live. Unset it and start again.");
    this.name = "FakesInProduction";
  }
}

/** True when PAYPAL_ENV points at live PayPal. "production" is what the PayPal clients read; "live" is refused too, to be safe. */
export function paypalIsLive(env: Env = process.env): boolean {
  const v = (env.PAYPAL_ENV ?? "").trim().toLowerCase();
  return v === "production" || v === "live";
}

/** Throws when E2E_FAKES is set to anything at all on a production server or against live PayPal. */
export function assertE2eFakesSafe(env: Env = process.env): void {
  if ((env.NODE_ENV === "production" || paypalIsLive(env)) && env.E2E_FAKES !== undefined && env.E2E_FAKES !== "") {
    throw new FakesInProduction();
  }
}

export class DemoWithLivePayPal extends Error {
  constructor() {
    super("DEMO_MODE=true must not run with live PayPal: anyone could pick Caretaker and move real money. Set DEMO_MODE=false or PAYPAL_ENV=sandbox and start again.");
    this.name = "DemoWithLivePayPal";
  }
}

/** Throws when DEMO_MODE is on and PayPal is live. */
export function assertDemoSafe(env: Env = process.env): void {
  if (env.DEMO_MODE === "true" && paypalIsLive(env)) throw new DemoWithLivePayPal();
}

/** Everything the web server and the worker check before they start. */
export function assertBootSafe(env: Env = process.env): void {
  assertE2eFakesSafe(env);
  assertDemoSafe(env);
}

/** True only for E2E_FAKES=true outside production. Every fake checks this, so none can be reached in production. */
export function e2eFakesEnabled(env: Env = process.env): boolean {
  assertE2eFakesSafe(env);
  return env.E2E_FAKES === "true";
}
