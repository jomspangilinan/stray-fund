import { NextResponse } from "next/server";
import { answerSex, assertUnderSexLimit, SEX_ANSWERS, type SexAnswer } from "@/server/catSex";
import { describeError } from "@/server/errors";
import { BodyTooLarge, readLimited } from "@/server/http";
import { isUuid } from "@/server/public";
import { RateLimited } from "@/server/spot";
import { JudgeOnly, requireJudge } from "@/server/judge";
import { AuthError, requireRole } from "@/server/session";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * One person's answer about one cat: female or male. It sets the sex only while the card says unknown;
 * a later, different answer is ignored and the reply says what the sex is. The reply holds the sex only,
 * never who answered.
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
    if (typeof answer !== "string" || !SEX_ANSWERS.includes(answer)) return fail("Answer female or male", 400);

    // Before any lock: a flood is turned away without waiting in line.
    await assertUnderSexLimit(session.userId);

    const sex = await answerSex(id, session.userId, answer as SexAnswer);
    if (!sex) return fail("There is no such cat", 404);
    return NextResponse.json({ sex }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof RateLimited) return fail("Too many answers in the last minute. Wait a moment and try again.", 429);
    if (e instanceof JudgeOnly) return fail(e.message, 403);
    if (e instanceof AuthError) return fail(e.message, e.status);
    console.error("Sex answer failed", describeError(e));
    return fail("Could not save that answer", 500);
  }
}
