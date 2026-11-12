import { isDemoMode } from "@/lib/config";

/*
 * The open demo lets any visitor tap Caretaker or Vet, and /api/spot stores the coordinates and the photo a
 * visitor really sends. So while DEMO_MODE is on, what a staff screen would show of someone else's real
 * spot is cut off in the loaders, not in the page: the area name instead of coordinates, a public or plain
 * placeholder picture instead of the original, a masked PayPal email. With DEMO_MODE off, real staff see it all.
 */

/**
 * True when private places, originals and emails must not leave the server for a staff screen. Off by default: the
 * owner tests the demo with sandbox data only. Set DEMO_HIDE_PRIVATE=true before the link is shared with strangers.
 */
export const hidePrivateInDemo = (): boolean => isDemoMode() && process.env.DEMO_HIDE_PRIVATE === "true";

/** Exact places stay hidden in the demo whatever DEMO_HIDE_PRIVATE says: they are real GPS points, not sandbox data. */
export const hidePlacesInDemo = (): boolean => isDemoMode();

/** r***@c***.test. Anything that is not an address becomes ***. */
export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const m = /^([^\s@])[^\s@]*@([^\s@])[^\s@]*\.([^\s@.]+)$/.exec(email.trim());
  return m ? `${m[1]}***@${m[2]}***.${m[3]}` : "***";
}

/** Shown in place of a private original while the demo is on. Plain SVG: no text or detail from the photo. */
export const HIDDEN_IN_DEMO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480" role="img" aria-label="Hidden in the demo">` +
  `<rect width="640" height="480" fill="#e9efe9"/>` +
  `<text x="320" y="240" font-family="sans-serif" font-size="32" font-weight="700" fill="#35423b" text-anchor="middle">Hidden in the demo</text>` +
  `</svg>`;

/** Coordinates for a staff screen: exact when allowed, otherwise nothing, with the flag that says why. */
export function placeForStaff<T extends { lat: number; lng: number; approximate: boolean }>(exact: T | null): { exact: T | null; exactHidden: boolean } {
  return hidePlacesInDemo() ? { exact: null, exactHidden: true } : { exact, exactHidden: false };
}

/** Seeded sample receipts carry an all-zero hash prefix that no real file can have. Only these may be served in the demo. */
export const isSampleReceipt = (sha256: string): boolean => /^0{63}[0-9a-f]$/.test(sha256);

/**
 * Seeded sample sightings are stored under a key with an all-zero random part (see sampleSightingKey), which no real
 * upload can have: real keys are random UUIDs. Only these originals are served in the demo, since they are drawings.
 */
export const isSampleSightingKey = (key: string): boolean => /^originals\/0{8}-0000-4000-8000-0{10}[0-9a-f]{2}\.jpg$/.test(key);

/** The plain "Hidden in the demo" picture as a response. */
export function hiddenInDemoResponse(): Response {
  return new Response(HIDDEN_IN_DEMO_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/** Every sentence the seed writes as the Treasurer or a review starts with this, which no real AI reason is told to do. */
export const SAMPLE_REASON = "Sample data. ";

/** Shown instead of the AI's free text on a staff screen in the demo, since a real visitor's note can come through it. */
export const HIDDEN_TEXT = "Hidden in the demo";

/** The AI's reason or a review's text for a staff screen: kept for our own sample rows, hidden in the demo otherwise. */
export function demoSafeText(text: string, sample: string = text): string {
  return hidePrivateInDemo() && !sample.startsWith(SAMPLE_REASON) ? HIDDEN_TEXT : text;
}
