import { NextResponse } from "next/server";
import { parseCatBox } from "@/lib/keepsake";
import { describeError } from "@/server/errors";
import { BodyTooLarge, parseForm, readLimited } from "@/server/http";
import { AuthError, requireRole } from "@/server/session";
import { loadReveal } from "@/server/spotReveal";
import { assertUnderRateLimit, processSpot, RateLimited } from "@/server/spot";
import { InvalidPhoto, MAX_BYTES } from "@/server/photos";

// Room for the multipart envelope around a photo that is itself at most MAX_BYTES.
const MAX_BODY = MAX_BYTES + 64 * 1024;

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

function coordinate(raw: FormDataEntryValue | null, min: number, max: number): number | null | "bad" {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return "bad";
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : "bad";
}

/**
 * Multipart form: photo (image/jpeg), optional lat and lng (both or neither), optional box (JSON fractions of the photo, where the camera saw the cat). Questions about the cat come after the photo.
 * The answer is a whitelist: state, catId, sightingId, message, and a reveal built by buildReveal. No coordinates, storage keys or assessment text.
 */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    // Checked before the body is read, so a flood of large uploads is cheap to refuse.
    await assertUnderRateLimit(session.userId);

    const form = await parseForm(req, await readLimited(req, MAX_BODY));
    if (!form) return fail("The photo did not send properly. Take it again.", 400);

    const photo = form.get("photo");
    if (!(photo instanceof Blob) || photo.size === 0) return fail("No photo was received. Take it again and send it.", 400);
    if (photo.type !== "image/jpeg") return fail("That photo type is not supported. Take it again with the camera.", 415);

    const lat = coordinate(form.get("lat"), -90, 90);
    const lng = coordinate(form.get("lng"), -180, 180);
    if (lat === "bad" || lng === "bad" || (lat === null) !== (lng === null)) {
      return fail("Send both a valid latitude and longitude, or neither", 400);
    }

    let box = null;
    const rawBox = form.get("box");
    if (rawBox !== null && rawBox !== "") {
      try {
        box = typeof rawBox === "string" ? parseCatBox(JSON.parse(rawBox)) : null;
      } catch {
        box = null;
      }
      if (!box) return fail("The photo did not send properly. Take it again.", 400);
    }

    const out = await processSpot({
      jpeg: Buffer.from(await photo.arrayBuffer()),
      lat,
      lng,
      userId: session.userId,
      box,
    });
    return NextResponse.json({
      state: out.state,
      catId: out.catId ?? null,
      sightingId: out.sightingId,
      message: out.message,
      reveal: await loadReveal(out.sightingId, out.state),
    });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, e.status);
    if (e instanceof BodyTooLarge) return fail("That photo is too large. Take it again.", 413);
    if (e instanceof RateLimited) return fail(e.message, 429);
    if (e instanceof InvalidPhoto) {
      return e.reason === "too_large"
        ? fail("That photo is too large. Take it again.", 413)
        : fail("We couldn't read that photo. Take it again with the camera.", 400);
    }
    console.error("Spot failed", describeError(e));
    return fail("Something went wrong on our side and the photo was not saved. Try again in a moment.", 500);
  }
}
