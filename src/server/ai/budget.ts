import { sql } from "drizzle-orm";
import { db } from "../db/client";

export const DEFAULT_DAILY_CAP = 500;

function dailyCap(): number {
  const raw = process.env.AI_DAILY_CALL_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/**
 * Takes one unit from today's budget (Asia/Manila date). One statement does the insert or the
 * conditional increment, so concurrent callers cannot pass the cap. At the cap the update is
 * skipped, no row comes back, and the counter is untouched.
 */
export async function consumeAiBudget(): Promise<boolean> {
  const cap = dailyCap();
  if (cap < 1) return false;
  const res = await db.execute(sql`
    insert into ai_usage (day, calls)
    values ((now() at time zone 'Asia/Manila')::date, 1)
    on conflict (day) do update set calls = ai_usage.calls + 1
      where ai_usage.calls < ${cap}
    returning calls
  `);
  return res.rows.length > 0;
}
