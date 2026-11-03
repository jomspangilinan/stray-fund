/** All money in this app is integer centavos (PHP). */

function assertCentavos(c: number): void {
  if (!Number.isSafeInteger(c) || c < 0) {
    throw new Error(`Invalid centavo amount: ${c}`);
  }
}

/** Centavos to a PayPal decimal string, e.g. 150050 -> "1500.50". */
export function toPayPalValue(c: number): string {
  assertCentavos(c);
  const whole = Math.floor(c / 100);
  const frac = String(c % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

/** PayPal decimal string to centavos. Accepts at most two decimals. */
export function fromPayPalValue(v: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new Error(`Invalid PayPal amount: ${JSON.stringify(v)}`);
  const centavos = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  assertCentavos(centavos);
  return centavos;
}

/** Display format, e.g. 150000 -> "₱1,500.00". Negative: "-₱1,500.00". */
export function formatPeso(c: number): string {
  if (!Number.isSafeInteger(c)) throw new Error(`Invalid centavo amount: ${c}`);
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${c < 0 ? "-" : ""}₱${whole}.${frac}`;
}

/** Pesos typed by a person ("1,500", "99.5") to centavos, or null if it is not an amount. */
export function parsePesoInput(text: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Whole pesos when there are no centavos, as in the home balance: 190700 -> "₱1,907". */
export function formatPesoShort(c: number): string {
  return formatPeso(c).replace(/\.00$/, "");
}
