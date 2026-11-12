import { NextResponse } from "next/server";
import { bodyRefusal, JSON_BODY_MAX, readJsonOrNull } from "@/server/http";
import { describeError } from "@/server/errors";
import { JudgeOnly, requireJudge } from "@/server/judge";
import { AuthError, requireRole } from "@/server/session";
import { createDonationOrder, InvalidAmount, InvalidAttempt, TooManyOrders } from "@/server/paypal/orders";

/** Body is {amount} in integer centavos and {attemptId}, a UUID the page makes per tap. Fee and net are never accepted. */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    await requireJudge();
    const body = (await readJsonOrNull(req, JSON_BODY_MAX)) as { amount?: unknown; attemptId?: unknown } | null;
    const { orderId } = await createDonationOrder(session.userId, body?.amount, body?.attemptId);
    return NextResponse.json({ orderId });
  } catch (e) {
    if (e instanceof JudgeOnly) return NextResponse.json({ error: e.message }, { status: 403 });
    const refused = bodyRefusal(e);
    if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof InvalidAmount || e instanceof InvalidAttempt) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof TooManyOrders) return NextResponse.json({ error: e.message }, { status: 429 });
    console.error("Create donation failed", describeError(e));
    return NextResponse.json({ error: "Could not start the donation" }, { status: 502 });
  }
}
