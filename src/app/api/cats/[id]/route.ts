import { NextResponse } from "next/server";
import { getCatForViewer } from "@/server/public";
import { getSession } from "@/server/session";
import { describeError } from "@/server/errors";

/** Public. Exact location is included only for caretakers and vets, and then never cached. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const session = await getSession();
    const cat = await getCatForViewer(id, session);
    if (!cat) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(cat, {
      headers: {
        "Cache-Control": cat.exact ? "no-store" : "public, max-age=30",
        Vary: "Cookie",
      },
    });
  } catch (e) {
    console.error("Cat lookup failed", describeError(e));
    return NextResponse.json({ error: "Could not load the cat" }, { status: 500 });
  }
}
