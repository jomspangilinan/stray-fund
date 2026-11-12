import { NextResponse } from "next/server";
import { Refusal } from "@/server/caretaker/shared";
import { anotherName } from "@/server/catNames";
import { describeError } from "@/server/errors";
import { isUuid } from "@/server/public";
import { JudgeOnly, requireJudge } from "@/server/judge";
import { AuthError, requireRole } from "@/server/session";
import { RateLimited } from "@/server/spot";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * The finder asks for another name. A free name from our own list is set at once, with no AI and no approval.
 * The server decides who the finder is and whether a caretaker has already named the cat.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    await requireJudge();
    const { id } = await ctx.params;
    if (!isUuid(id)) return fail("There is no such cat", 404);
    // A JSON content type means a form on another site cannot post here.
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail("Send the request as JSON", 415);
    }
    const name = await anotherName(session.userId, id);
    return NextResponse.json({ name }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof RateLimited) return fail("Too many changes in the last minute. Wait a moment and try again.", 429);
    if (e instanceof JudgeOnly) return fail(e.message, 403);
    if (e instanceof AuthError || e instanceof Refusal) return fail(e.message, e.status);
    console.error("Another name failed", describeError(e));
    return fail("Could not change the name", 500);
  }
}
