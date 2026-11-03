import { NextResponse } from "next/server";
import { describeError } from "@/server/errors";
import { getLedgerSnapshot } from "@/server/impact";

/** Public. The same for every visitor, so it reads no session. Never stored, so the ledger stays live. */
export async function GET() {
  try {
    return NextResponse.json(await getLedgerSnapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("Ledger failed", describeError(e));
    return NextResponse.json({ error: "Could not load the ledger" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
