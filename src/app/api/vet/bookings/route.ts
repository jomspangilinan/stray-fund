import { NextResponse } from "next/server";
import { bodyRefusal, JSON_BODY_MAX, readJson } from "@/server/http";
import { RateLimited } from "@/server/spot";
import { describeError } from "@/server/errors";
import { isUuid, manilaDate } from "@/server/public";
import { AuthError, requireRole } from "@/server/session";
import { assertUnderBookingLimit, confirmBooking, VetFlowError } from "@/server/vetFlow";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** JSON body: catId, date as YYYY-MM-DD in Manila. The answer is a whitelist of the booking. */
export async function POST(req: Request) {
  try {
    const session = await requireRole("vet");
    await assertUnderBookingLimit(session.userId);

    let body: { catId?: unknown; date?: unknown };
    try {
      body = (await readJson(req, JSON_BODY_MAX)) as typeof body;
    } catch (e) {
      const refused = bodyRefusal(e);
      if (refused) return fail(refused.message, refused.status);
      return fail("Send the booking as JSON", 400);
    }
    if (typeof body?.catId !== "string" || !isUuid(body.catId)) return fail("There is no such cat", 404);
    if (typeof body.date !== "string") return fail("Choose a date", 400);

    const booking = await confirmBooking(session.userId, body.catId, body.date);
    return NextResponse.json(
      {
        id: booking.id,
        status: booking.status,
        packagePrice: booking.packagePrice,
        scheduledFor: booking.scheduledFor ? manilaDate(booking.scheduledFor) : null,
      },
      { status: 201, headers: NO_STORE },
    );
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, e.status);
    if (e instanceof VetFlowError) return fail(e.message, e.status);
    if (e instanceof RateLimited) return fail("Too many bookings in the last minute. Wait a moment and try again.", 429);
    console.error("Booking failed", describeError(e));
    return fail("Could not make that booking", 500);
  }
}
