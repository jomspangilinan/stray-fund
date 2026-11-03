import { NextResponse } from "next/server";
import { getKeepsake } from "@/server/keepsake";
import { isUuid } from "@/server/public";

/** What the Save image picture is drawn from. Public fields only, so no sign-in is needed. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "There is no such cat" }, { status: 404 });
  const data = await getKeepsake(id);
  if (!data) return NextResponse.json({ error: "This cat has no photo to save yet" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
