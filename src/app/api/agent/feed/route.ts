import { NextResponse } from "next/server";
import { describeError } from "@/server/errors";
import { listAgentActions } from "@/server/public";

/** Public. The same for every visitor, so it reads no session. Never stored, so the feed stays live. */
export async function GET() {
  try {
    const actions = await listAgentActions();
    return NextResponse.json({ actions }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("Agent feed failed", describeError(e));
    return NextResponse.json({ error: "Could not load the feed" }, { status: 500 });
  }
}
