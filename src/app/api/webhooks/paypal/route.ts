import { NextResponse } from "next/server";
import { handleWebhookEvent, verifyWebhook, type WebhookEvent } from "@/server/paypal/webhook";

export async function POST(req: Request) {
  // Read once, as text. The same bytes go to verification and to JSON.parse.
  const raw = await req.text();
  try {
    if (!(await verifyWebhook(req.headers, raw))) {
      return NextResponse.json({ error: "Bad signature" }, { status: 400 });
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(raw) as WebhookEvent;
    } catch {
      return NextResponse.json({ error: "Bad body" }, { status: 400 });
    }
    if (typeof event?.id !== "string" || typeof event.event_type !== "string") {
      return NextResponse.json({ error: "Bad event" }, { status: 400 });
    }
    const result = await handleWebhookEvent(event);
    return NextResponse.json({ result });
  } catch (e) {
    console.error("Webhook failed", e instanceof Error ? e.name : e);
    return NextResponse.json({ error: "Try again" }, { status: 500 });
  }
}
