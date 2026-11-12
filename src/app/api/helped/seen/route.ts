import { NextResponse } from "next/server";
import { bodyRefusal, JSON_BODY_MAX, readJsonOrNull } from "@/server/http";
import { confirmCelebrationSeen } from "@/server/milestones";
import { getHelpedEntries } from "@/server/public";
import { AuthError, requireRole } from "@/server/session";

/** The browser says the celebration note was shown. Only a milestone that is true for this donor is marked. */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const body = (await readJsonOrNull(req, JSON_BODY_MAX)) as { catId?: unknown; milestone?: unknown } | null;
    if (!body || typeof body.catId !== "string" || typeof body.milestone !== "string") {
      return NextResponse.json({ error: "Send catId and milestone" }, { status: 400 });
    }
    const marked = await confirmCelebrationSeen(session.userId, await getHelpedEntries(session.userId), {
      catId: body.catId,
      milestone: body.milestone,
    });
    return NextResponse.json({ marked });
  } catch (e) {
    const refused = bodyRefusal(e);
    if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not save that" }, { status: 500 });
  }
}
