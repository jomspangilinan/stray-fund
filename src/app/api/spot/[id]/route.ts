import { NextResponse } from "next/server";
import { describeError } from "@/server/errors";
import { isUuid } from "@/server/public";
import { AuthError, requireRole } from "@/server/session";
import { getSpotStatus } from "@/server/spot";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** Whether the signed-in person's own photo is developed yet. Another person's sighting answers 404, like a missing one. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const { id } = await ctx.params;
    if (!isUuid(id)) return fail("There is no such photo.", 404);
    const status = await getSpotStatus(session.userId, id);
    if (!status) return fail("There is no such photo.", 404);
    return NextResponse.json(status, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, e.status);
    console.error("Spot status failed", describeError(e));
    return fail("Something went wrong on our side. Try again in a moment.", 500);
  }
}
