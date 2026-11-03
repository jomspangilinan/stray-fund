import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.DATABASE_URL;

async function loadHandler() {
  vi.resetModules();
  const mod = await import("../src/app/api/health/route");
  const db = await import("../src/lib/db");
  return { GET: mod.GET, closePool: db.closePool };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("health returns ok and db true", async () => {
    const { GET, closePool } = await loadHandler();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
    await closePool();
  });

  it("returns 503 with db false when the database is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
    const { GET, closePool } = await loadHandler();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
    await closePool();
  });
});
