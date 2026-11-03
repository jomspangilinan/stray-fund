import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { bookings, receipts, sightings } from "@/server/db/schema";
import { isUuid } from "@/server/public";
import { getSession } from "@/server/session";
import { getStorage } from "@/server/storage";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Original, private photos for people who are allowed to see them: caretakers, and the vet whose
 * booking a receipt belongs to. Anyone else, signed in or not, gets the same 404 as a missing
 * photo. The storage key comes from the database row for the id, never from the request.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await ctx.params;
  if (!isUuid(id)) return NOT_FOUND();
  const session = await getSession();
  if (session?.role !== "caretaker" && session?.role !== "vet") return NOT_FOUND();

  let key: string | null = null;
  if (kind === "receipt" || kind === "eartip") {
    const [row] = await db
      .select({ fileKey: receipts.fileKey, earKey: receipts.earTipPhotoKey, vetId: bookings.vetId })
      .from(receipts)
      .innerJoin(bookings, eq(bookings.id, receipts.bookingId))
      .where(eq(receipts.id, id));
    if (!row) return NOT_FOUND();
    if (session.role === "vet" && row.vetId !== session.userId) return NOT_FOUND();
    key = kind === "receipt" ? row.fileKey : row.earKey;
  } else if (kind === "sighting" && session.role === "caretaker") {
    const [row] = await db.select({ key: sightings.originalKey }).from(sightings).where(eq(sightings.id, id));
    key = row?.key ?? null;
  }
  if (!key) return NOT_FOUND();

  try {
    const bytes = await getStorage().getPrivate(key);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return NOT_FOUND();
  }
}
