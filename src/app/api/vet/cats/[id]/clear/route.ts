import { NextResponse } from "next/server";
import { withColonyLock } from "@/server/db/client";
import { describeError } from "@/server/errors";
import { isUuid } from "@/server/public";
import { clearCatForSurgery } from "@/server/reports";
import { AuthError, requireRole } from "@/server/session";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * A vet clears a cat for surgery, which ends its confirmed holds. A JSON content type is required so a form on
 * another site cannot post here. A cat with nothing confirmed gets 409, which is also what a second tap gets.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole("vet");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail("Send the request as JSON", 415);
    }
    const { id } = await ctx.params;
    if (!isUuid(id)) return fail("There is no such cat", 404);

    const cleared = await withColonyLock((tx) => clearCatForSurgery(tx, id, session.userId));
    if (cleared === 0) return fail("This cat has nothing waiting for a check", 409);
    return NextResponse.json({ ok: true, message: "Cleared for surgery." }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, e.status);
    console.error("Clear failed", describeError(e));
    return fail("Could not clear that cat", 500);
  }
}
