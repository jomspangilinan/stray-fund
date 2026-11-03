import { NextResponse } from "next/server";
import { AuthError, requireRole } from "@/server/session";
import {
  captureDonation,
  CaptureMismatch,
  ForbiddenOrder,
  UnknownOrder,
} from "@/server/paypal/orders";
import { CAPTURED } from "@/server/ledger";

export async function POST(_req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const { orderId } = await ctx.params;
    const d = await captureDonation(session.userId, orderId);
    return NextResponse.json({
      status: d.status === CAPTURED ? "captured" : "pending",
      gross: d.gross,
      net: d.net,
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ForbiddenOrder) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof UnknownOrder) return NextResponse.json({ error: "Unknown order" }, { status: 404 });
    if (e instanceof CaptureMismatch) {
      console.error("Capture mismatch", e.message);
      return NextResponse.json({ error: "The payment did not add up and was not recorded" }, { status: 502 });
    }
    console.error("Capture failed", e);
    return NextResponse.json({ error: "Could not confirm the payment" }, { status: 502 });
  }
}
