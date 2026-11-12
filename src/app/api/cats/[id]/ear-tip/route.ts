import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { cats } from "@/server/db/schema";
import { assertUnderFlagLimit, setEarTipFlag, type EarTipValue } from "@/server/earTipFlags";
import { describeError } from "@/server/errors";
import { BodyTooLarge, readLimited } from "@/server/http";
import { isUuid } from "@/server/public";
import { RateLimited } from "@/server/spot";
import { JudgeOnly, requireJudge } from "@/server/judge";
import { AuthError, requireRole } from "@/server/session";

const NO_STORE = { "Cache-Control": "no-store" };
const ANSWERS: Record<string, EarTipValue | null> = { yes: "yes", no: "no", unsure: null };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * One person's answer about one cat: yes, no or unsure. Unsure takes an earlier answer back. The reply
 * holds only that person's own answer, never a count and never anyone else's.
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
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(await readLimited(req, 1024)).toString("utf8"));
    } catch (e) {
      return e instanceof BodyTooLarge ? fail("That request is too large", 413) : fail("Send a valid JSON object", 400);
    }
    const answer = (body as { answer?: unknown } | null)?.answer;
    if (typeof answer !== "string" || !Object.hasOwn(ANSWERS, answer)) return fail("Answer yes, no or unsure", 400);

    // Before any lock: a flood is turned away without waiting in line.
    await assertUnderFlagLimit(session.userId);

    const [cat] = await db.select({ id: cats.id }).from(cats).where(eq(cats.id, id));
    if (!cat) return fail("There is no such cat", 404);

    const value = ANSWERS[answer];
    await setEarTipFlag(id, session.userId, value);
    return NextResponse.json({ answer: value ?? "unsure" }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof RateLimited) return fail("Too many answers in the last minute. Wait a moment and try again.", 429);
    if (e instanceof JudgeOnly) return fail(e.message, 403);
    if (e instanceof AuthError) return fail(e.message, e.status);
    console.error("Ear-tip answer failed", describeError(e));
    return fail("Could not save that answer", 500);
  }
}
