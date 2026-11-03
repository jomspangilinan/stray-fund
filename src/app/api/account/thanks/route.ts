import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { AuthError, requireRole } from "@/server/session";

/** Sets whether this person's username may appear in thanks. Off shows "A neighbour". */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    const body = (await req.json().catch(() => null)) as { show?: unknown } | null;
    if (!body || typeof body.show !== "boolean") return NextResponse.json({ error: "Send show as true or false" }, { status: 400 });
    await db.update(users).set({ showNameInThanks: body.show }).where(eq(users.id, session.userId));
    return NextResponse.json({ show: body.show });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not save that" }, { status: 500 });
  }
}
