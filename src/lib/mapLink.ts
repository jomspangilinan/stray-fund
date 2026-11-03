export type MapSpot = { lat: number; lng: number; approximate: boolean } | null;
export type MapLink = { href: string; label: string };

const BASE = "https://www.google.com/maps";
const at = (s: { lat: number; lng: number }) => encodeURIComponent(`${s.lat},${s.lng}`);

/**
 * Staff only. Google's documented Maps URLs, so nothing is sent to Google until a person taps the link.
 * Directions only for a real spot; the middle of an area would mislead. The demo link holds the area name, never coordinates.
 */
export function mapLink({ exact, area, exactHidden }: { exact: MapSpot; area: string; exactHidden: boolean }): MapLink | null {
  if (exactHidden) return { href: `${BASE}/search/?api=1&query=${encodeURIComponent(area)}`, label: "See area on map" };
  if (!exact) return null;
  if (exact.approximate) return { href: `${BASE}/search/?api=1&query=${at(exact)}`, label: "See on map" };
  return { href: `${BASE}/dir/?api=1&destination=${at(exact)}`, label: "Get directions" };
}
