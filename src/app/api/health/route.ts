import { getPool } from "@/server/db/pool";

export async function GET() {
  try {
    await getPool().query("select 1");
    return Response.json({ ok: true, db: true });
  } catch {
    return Response.json({ ok: false, db: false }, { status: 503 });
  }
}
