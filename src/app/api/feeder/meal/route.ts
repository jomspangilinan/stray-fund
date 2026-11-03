import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { describeError } from "@/server/errors";

const MAX_SOURCE = 40;
const MIN_GAP_SECONDS = 60;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time check against FEEDER_TOKEN. An unset or empty token never matches anything. */
function authorized(req: Request): boolean {
  const expected = process.env.FEEDER_TOKEN;
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(expected));
}

async function readSource(req: Request): Promise<string> {
  try {
    const body = (await req.json()) as { source?: unknown };
    if (typeof body.source === "string" && body.source.trim()) return body.source.trim().slice(0, MAX_SOURCE);
  } catch {
    // The body is optional.
  }
  return "feeder";
}

/** Logs one meal for the impact page. At most one is recorded per minute; repeats answer recorded:false. */
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const source = await readSource(req);
    const recorded = await db.transaction(async (tx) => {
      // Serialises concurrent callers so the one-per-minute check cannot be raced.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('feeder_meal'))`);
      const { rows } = await tx.execute(sql`
        insert into meals (source)
        select ${source}
        where not exists (
          select 1 from meals where created_at > now() - make_interval(secs => ${MIN_GAP_SECONDS})
        )
        returning id
      `);
      return rows.length > 0;
    });
    return NextResponse.json({ recorded });
  } catch (e) {
    console.error("Meal failed", describeError(e));
    return NextResponse.json({ error: "Could not record the meal" }, { status: 500 });
  }
}
