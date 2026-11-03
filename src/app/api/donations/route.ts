import { NextResponse } from "next/server";
import { AuthError, requireRole } from "@/server/session";
import { createDonationOrder, InvalidAmount } from "@/server/paypal/orders";

/** Body is {amount} in integer centavos. Fee and net are never accepted. */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const body = (await req.json().catch(() => null)) as { amount?: unknown } | null;
    const { orderId } = await createDonationOrder(session.userId, body?.amount);
    return NextResponse.json({ orderId });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof InvalidAmount) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("Create donation failed", e);
    return NextResponse.json({ error: "Could not start the donation" }, { status: 502 });
  }
}
