import path from "node:path";
import { config } from "dotenv";

// A throwaway file in the repo root, never committed (.env* is ignored). It holds only E2E_DATABASE_URL.
config({ path: ".env.e2e", quiet: true });

export const PORT = Number(process.env.E2E_PORT || 3227);
export const BASE_URL = `http://localhost:${PORT}`;
export const OUT_DIR = path.resolve("test-results", "e2e-data");
export const FAKE_LOG = path.join(OUT_DIR, "fake-paypal.log");
export const CAMERA_FIXTURE = path.resolve("tests", "fixtures", "camera.y4m");

/** The test empties every table, so it will only touch a database whose name ends in _e2e. */
export function databaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set. Point it at a scratch database whose name ends in _e2e.");
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/_e2e$/.test(name)) throw new Error(`Refusing to use database "${name}": the end-to-end test empties it, so its name must end in _e2e.`);
  return url;
}

/** Everything the app and the worker need. No real credential appears here. */
export function appEnv(): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(),
    E2E_FAKES: "true",
    E2E_FAKE_LOG: FAKE_LOG,
    DEMO_MODE: "true",
    SESSION_SECRET: "e2e-only-session-secret-not-for-real-use-0123456789",
    // A fake id: the donate page needs one to draw its buttons, and the test serves a fake PayPal script for it.
    PAYPAL_CLIENT_ID: "e2e-fake-client-id",
    PAYPAL_CLIENT_SECRET: "e2e-fake-client-secret",
    PAYPAL_ENV: "sandbox",
    PAYPAL_VET_EMAIL: "demo-vet@e2e.invalid",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(OUT_DIR, "photos"),
    AI_DAILY_CALL_CAP: "500",
    // No gate, so the loop is not gated even if .env.local turns it on.
    JUDGE_GATE: "",
  };
}
