import { NextResponse } from "next/server";
import { describeError } from "@/server/errors";
import { getImpact } from "@/server/impact";

/** Public. Counts and pool figures only. Never stored. */
export async function GET() {
  try {
    return NextResponse.json(await getImpact(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("Impact failed", describeError(e));
    return NextResponse.json({ error: "Could not load the impact figures" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
