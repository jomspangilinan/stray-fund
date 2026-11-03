export const APP_NAME = "Stray Fund";
export const CURRENCY = "PHP";
export const DEMO_MODE = process.env.DEMO_MODE === "true";

export const COLONY = {
  name: "Brgy. San Antonio colony",
  area_name: "Brgy. San Antonio, near the market",
  // Invented placeholder coordinates, not a real location.
  centre: { lat: 10.1234, lng: 120.5678 },
} as const;
