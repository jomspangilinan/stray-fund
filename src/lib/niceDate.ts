const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A plain date (YYYY-MM-DD) as "3 Nov 2026". Anything else comes back unchanged. */
export function niceDate(iso: string): string {
  if (!PLAIN_DATE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
