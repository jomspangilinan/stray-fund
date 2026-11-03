import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { sql } from "drizzle-orm";
import { meals } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { POST } from "../src/app/api/feeder/meal/route";

const TOKEN = "feeder-token-for-tests";
const call = (headers: Record<string, string>, body?: unknown) =>
  POST(
    new Request("http://localhost/api/feeder/meal", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const good = { authorization: `Bearer ${TOKEN}` };

describe("POST /api/feeder/meal", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.stubEnv("FEEDER_TOKEN", TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(closePool);

  it("rejects a missing or wrong token", async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await call({ authorization: TOKEN })).status).toBe(401);
    expect(await db.select().from(meals)).toHaveLength(0);
  });

  it("is never open when FEEDER_TOKEN is unset or empty", async () => {
    vi.stubEnv("FEEDER_TOKEN", "");
    expect((await call({ authorization: "Bearer " })).status).toBe(401);
    expect((await call({})).status).toBe(401);
    vi.stubEnv("FEEDER_TOKEN", undefined as unknown as string);
    expect((await call({ authorization: "Bearer undefined" })).status).toBe(401);
  });

  it("records a meal with a good token, defaulting the source", async () => {
    const res = await call(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    const rows = await db.select().from(meals);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("feeder");
  });

  it("caps the source at 40 characters", async () => {
    await call(good, { source: "x".repeat(100) });
    expect((await db.select().from(meals))[0].source).toHaveLength(40);
  });

  it("tolerates a junk body", async () => {
    const res = await POST(
      new Request("http://localhost/api/feeder/meal", { method: "POST", headers: good, body: "not json" }),
    );
    expect(res.status).toBe(200);
  });

  it("records at most one meal per 60 seconds", async () => {
    await call(good);
    const res = await call(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: false });
    expect(await db.select().from(meals)).toHaveLength(1);
  });

  it("records again once 60 seconds have passed", async () => {
    await call(good);
    await db.execute(sql`update meals set created_at = now() - interval '61 seconds'`);
    expect(await (await call(good)).json()).toEqual({ recorded: true });
  });

  it("dedupes concurrent calls", async () => {
    await Promise.all([call(good), call(good), call(good)]);
    expect(await db.select().from(meals)).toHaveLength(1);
  });
});
