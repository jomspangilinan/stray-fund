import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { withColonyLock } from "@/server/db/client";
import { sightings } from "@/server/db/schema";
import { describeError } from "@/server/errors";
import { BodyTooLarge, readLimited } from "@/server/http";
import { isUuid } from "@/server/public";
import { CLAIMS, fileReport, ReportRefused, type Claim } from "@/server/reports";
import { JudgeOnly, requireJudge } from "@/server/judge";
import { AuthError, requireRole } from "@/server/session";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

const MAX_BODY = 4096;
const MAX_NOTE = 280;
/** A report rides on a live photo, so the photo must be fresh. */
const MAX_PHOTO_AGE_MINUTES = 30;

const NOT_FOUND = "We can't find that photo. Take a new photo to report something.";
const TOO_OLD = "That photo is too old. Take a new photo to report something.";
/** Answered with 200: nothing went wrong, so the screen says it plainly and does not show an error. */
const SOFT: Record<string, string> = {
  already_today: "You already told us about this today.",
  dismissed_before: "A caretaker already checked this.",
};

/** A photo with no cat yet: the report waits, and is closed if that cat was already checked for this. */
const WAITING_FOR_CAT = "Thanks. A caretaker sorts the photo first. If that cat was already checked for this, it is closed.";

/**
 * One finder's claim about the cat in a photo they just took: { sightingId, claim, note? }. The cat comes from
 * the sighting, never from the body, and a photo still waiting on a caretaker has none yet, so the report
 * attaches when the photo is sorted. Signed-out callers never get here: the spot flow needs a session to take
 * the photo, so a sighting with no owner can be reported by nobody.
 * The answer is { ok: true }, plus a plain message when the report was not filed because it is a repeat.
 */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    await requireJudge();

    // A JSON content type means a form on another site cannot post here.
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail("Send the request as JSON", 415);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(await readLimited(req, MAX_BODY)).toString("utf8"));
    } catch (e) {
      return e instanceof BodyTooLarge ? fail("That request is too large", 413) : fail("Send a valid JSON object", 400);
    }
    const input = (body ?? {}) as { sightingId?: unknown; claim?: unknown; note?: unknown };
    if (typeof input.sightingId !== "string" || !isUuid(input.sightingId)) return fail("Choose the photo to report on", 400);
    if (typeof input.claim !== "string" || !(CLAIMS as readonly string[]).includes(input.claim)) {
      return fail("Choose what is wrong with the cat", 400);
    }
    if (input.note !== undefined && input.note !== null && typeof input.note !== "string") return fail("The note must be text", 400);
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (note.length > MAX_NOTE) return fail(`Keep the note under ${MAX_NOTE} characters`, 400);

    const sightingId = input.sightingId;
    const claim = input.claim as Claim;
    return await withColonyLock(async (tx) => {
      const [s] = await tx
        .select({
          catId: sightings.catId,
          caughtBy: sightings.caughtByUserId,
          state: sightings.state,
          stale: sql<boolean>`${sightings.createdAt} < now() - make_interval(mins => ${MAX_PHOTO_AGE_MINUTES})`,
        })
        .from(sightings)
        .where(eq(sightings.id, sightingId));
      // Someone else's photo looks the same as no photo, so a guess reveals nothing.
      if (!s || s.caughtBy !== session.userId || s.state === "rejected") return fail(NOT_FOUND, 404);
      if (s.stale) return fail(TOO_OLD, 409);
      try {
        await fileReport(tx, {
          sightingId,
          catId: s.catId,
          claim,
          note: note === "" ? null : note,
          source: "neighbour",
          reporterId: session.userId,
        });
      } catch (e) {
        if (e instanceof ReportRefused) {
          const message = SOFT[e.reason];
          if (message) return NextResponse.json({ ok: true, message }, { headers: NO_STORE });
          return e.reason === "sighting_mismatch" ? fail("That photo changed. Take a new photo to report something.", 409) : fail(NOT_FOUND, 404);
        }
        throw e;
      }
      return NextResponse.json(s.catId === null ? { ok: true, message: WAITING_FOR_CAT } : { ok: true }, { headers: NO_STORE });
    });
  } catch (e) {
    if (e instanceof JudgeOnly) return fail(e.message, 403);
    if (e instanceof AuthError) return fail(e.message, e.status);
    console.error("Report failed", describeError(e));
    return fail("Something went wrong on our side and the report was not saved. Try again in a moment.", 500);
  }
}
