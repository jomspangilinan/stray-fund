/** The only parts of a foreign error that are safe to log: no request or response bodies. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return "non-error thrown";
  const status = (e as Error & { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? `${e.name} (HTTP ${status})` : e.name;
}
