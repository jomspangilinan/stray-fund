export const APP_NAME = "Stray Fund";
export const CURRENCY = "PHP";
export const DEMO_MODE = process.env.DEMO_MODE === "true";

export const COLONY = {
  name: "Brgy. San Antonio colony",
  area_name: "Brgy. San Antonio, near the market",
  // Invented placeholder coordinates, not a real location.
  centre: { lat: 10.1234, lng: 120.5678 },
  // PLACEHOLDER: an invented target for the demo. Replace it with the real goal the neighbourhood agrees on.
  goalCats: 30,
} as const;

/** Read at call time so tests and deploys can change it. */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

/** True while PayPal is not live. Words like "Test money only" are shown only when this is true. */
export function moneyIsTest(): boolean {
  const v = (process.env.PAYPAL_ENV ?? "").trim().toLowerCase();
  return v !== "production" && v !== "live";
}

/** Smallest donation, in centavos (PHP 100). */
export const MIN_DONATION = 10_000;
/** Largest single donation, in centavos (PHP 100,000). A sanity cap. */
export const MAX_DONATION = 10_000_000;
