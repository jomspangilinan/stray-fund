import { NextResponse } from "next/server";
import { bodyRefusal, readLimited, WEBHOOK_BODY_MAX } from "@/server/http";
import { handleWebhookEvent, verifyWebhook, type WebhookEvent } from "@/server/paypal/webhook";

export async function POST(req: Request) {
  try {
    // Read once, capped. The same bytes go to verification and to JSON.parse.
    let raw: string;
    try {
      raw = Buffer.from(await readLimited(req, WEBHOOK_BODY_MAX)).toString("utf8");
    } catch (e) {
      const refused = bodyRefusal(e);
      if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });
      throw e;
    }
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
