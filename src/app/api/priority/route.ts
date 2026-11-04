import { NextResponse } from "next/server";
import { describeError } from "@/server/errors";
import { getPriorityList } from "@/server/public";

/** Public. The same for every visitor, so it reads no session. Never stored, so the list stays live. */
export async function GET() {
  try {
    return NextResponse.json(await getPriorityList(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("Priority list failed", describeError(e));
    return NextResponse.json({ error: "Could not load the priority list" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
