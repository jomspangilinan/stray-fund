import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import sharp from "sharp";
import { databaseUrl, FAKE_LOG } from "./env";

/** Reads the scratch database directly. The test only reads through this; every change goes through the app. */
export class Db {
  private pool = new Pool({ connectionString: databaseUrl() });
  async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }
  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.rows<T>(sql, params);
    expect(rows, sql).toHaveLength(1);
    return rows[0];
  }
  async close() {
    await this.pool.end();
  }
}

/** The calls the fake PayPal saw, in order. */
export function fakePayPalCalls(): { call: string; [k: string]: unknown }[] {
  try {
    return readFileSync(FAKE_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function signInAs(page: Page, username: string): Promise<void> {
  const res = await page.request.post("/api/session", { data: { username } });
  expect(res.ok(), `sign in as ${username}`).toBeTruthy();
}

export async function pickRole(page: Page, label: "Neighbour" | "Caretaker" | "Vet"): Promise<void> {
  await page.getByRole("group", { name: "View the app as" }).getByRole("button", { name: label }).click();
  await expect(page.getByRole("group", { name: "View the app as" }).getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
}

/** A picture W pixels wide. The fake AI reads it as a receipt for W pesos. */
export async function receiptImage(pesos: number): Promise<Buffer> {
  const lines = ["BRGY. SAN ANTONIO VET CLINIC", "Official receipt", "Spay or neuter surgery", "Anti-rabies vaccine", "Deworming", `TOTAL PHP ${pesos.toLocaleString("en-US")}.00`];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pesos}" height="900"><rect width="100%" height="100%" fill="#fff"/>${lines
    .map((t, i) => `<text x="60" y="${110 + i * 90}" font-family="monospace" font-size="52" fill="#111">${t}</text>`)
    .join("")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

/** PayPal's own shape for a payout item event. The fake signature is what the fake check accepts. */
export function payoutEvent(eventId: string, p: { batchId: string; senderBatchId: string; fee: string }) {
  return {
    id: eventId,
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource: {
      payout_batch_id: p.batchId,
      sender_batch_id: p.senderBatchId,
      payout_item_id: `E2E-ITEM-${eventId}`,
      transaction_status: "SUCCESS",
      payout_item_fee: { currency: "PHP", value: p.fee },
    },
  };
}

export const PAYPAL_HEADERS = {
  "content-type": "application/json",
  "paypal-auth-algo": "E2E",
  "paypal-cert-url": "https://e2e.invalid/cert",
  "paypal-transmission-id": "e2e-transmission",
  "paypal-transmission-time": "2026-11-03T00:00:00Z",
  "paypal-transmission-sig": "e2e-fake-signature",
};
