import { isDemoMode } from "@/lib/config";

/*
 * The open demo lets any visitor tap Caretaker or Vet, and /api/spot stores the coordinates and the photo a
 * visitor really sends. So while DEMO_MODE is on, what a staff screen would show of someone else's real
 * spot is cut off in the loaders, not in the page: the area name instead of coordinates, a public or plain
 * placeholder picture instead of the original, a masked PayPal email. With DEMO_MODE off, real staff see it all.
 */

/** True when private places, originals and emails must not leave the server for a staff screen. */
export const hidePrivateInDemo = (): boolean => isDemoMode();

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
  return hidePrivateInDemo() ? { exact: null, exactHidden: true } : { exact, exactHidden: false };
}
