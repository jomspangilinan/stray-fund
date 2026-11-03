import { NextResponse } from "next/server";
import { Refusal } from "@/server/caretaker/shared";
import { suggestName } from "@/server/catNames";
import { describeError } from "@/server/errors";
import { BodyTooLarge, readLimited } from "@/server/http";
import { isUuid } from "@/server/public";
import { AuthError, requireRole } from "@/server/session";
import { RateLimited } from "@/server/spot";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * A neighbour suggests the cat's real name. It waits for a caretaker and changes nothing public. The reply holds
 * only this person's own suggestion.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const { id } = await ctx.params;
    if (!isUuid(id)) return fail("There is no such cat", 404);
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail("Send the request as JSON", 415);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(await readLimited(req, 1024)).toString("utf8"));
    } catch (e) {
      return e instanceof BodyTooLarge ? fail("That request is too large", 413) : fail("Send a valid JSON object", 400);
    }
    const pending = await suggestName(session.userId, id, (body as { name?: unknown } | null)?.name);
    return NextResponse.json({ pending }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof RateLimited) return fail("Too many names in the last minute. Wait a moment and try again.", 429);
    if (e instanceof AuthError || e instanceof Refusal) return fail(e.message, e.status);
    console.error("Name suggestion failed", describeError(e));
    return fail("Could not save that name", 500);
  }
}
