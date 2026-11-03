import { NextResponse } from "next/server";
import { markNewsSeen } from "@/server/news";
import { AuthError, requireRole } from "@/server/session";

/** The browser says the news list was shown. The marker only moves forward, and never past now. */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const body = (await req.json().catch(() => null)) as { upTo?: unknown } | null;
    if (!body || typeof body.upTo !== "string") return NextResponse.json({ error: "Send upTo" }, { status: 400 });
    await markNewsSeen(session.userId, body.upTo);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not save that" }, { status: 500 });
  }
}
