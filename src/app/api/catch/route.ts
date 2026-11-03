import { NextResponse } from "next/server";
import { describeError } from "@/server/errors";
import { AuthError, requireRole } from "@/server/session";
import { assertUnderRateLimit, processCatch, RateLimited, type Sex } from "@/server/catch";
import { InvalidPhoto, MAX_BYTES } from "@/server/photos";

// Room for the multipart envelope around a photo that is itself at most MAX_BYTES.
const MAX_BODY = MAX_BYTES + 64 * 1024;
const SEXES = new Set<string>(["female", "male", "unknown"]);

class TooBig extends Error {}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/** Reads the body, giving up as soon as it passes the limit instead of buffering all of it. */
async function readLimited(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new TooBig();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new TooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function coordinate(raw: FormDataEntryValue | null, min: number, max: number): number | null | "bad" {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return "bad";
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : "bad";
}

/**
 * Multipart form: photo (image/jpeg), optional lat and lng (both or neither), optional sex.
 * The answer is a whitelist: state, catId, sightingId, message. No coordinates or storage keys.
 */
export async function POST(req: Request) {
  try {
    const session = await requireRole("donor", "caretaker", "vet", "foster");
    // Checked before the body is read, so a flood of large uploads is cheap to refuse.
    await assertUnderRateLimit(session.userId);

    const raw = await readLimited(req);
    let form: FormData;
    try {
      form = await new Request(req.url, {
        method: "POST",
        headers: { "content-type": req.headers.get("content-type") ?? "" },
        body: raw as BodyInit,
      }).formData();
    } catch {
      return fail("Send the photo as a form", 400);
    }

    const photo = form.get("photo");
    if (!(photo instanceof Blob) || photo.size === 0) return fail("A photo is required", 400);
    if (photo.type !== "image/jpeg") return fail("The photo must be a JPEG", 415);

    const lat = coordinate(form.get("lat"), -90, 90);
    const lng = coordinate(form.get("lng"), -180, 180);
    if (lat === "bad" || lng === "bad" || (lat === null) !== (lng === null)) {
      return fail("Send both a valid latitude and longitude, or neither", 400);
    }
    const sexRaw = form.get("sex");
    if (sexRaw !== null && sexRaw !== "" && (typeof sexRaw !== "string" || !SEXES.has(sexRaw))) {
      return fail("Sex must be female, male or unknown", 400);
    }

    const out = await processCatch({
      jpeg: Buffer.from(await photo.arrayBuffer()),
      lat,
      lng,
      userId: session.userId,
      sex: sexRaw ? (sexRaw as Sex) : undefined,
    });
    return NextResponse.json({
      state: out.state,
      catId: out.catId ?? null,
      sightingId: out.sightingId,
      message: out.message,
    });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, e.status);
    if (e instanceof TooBig) return fail("That photo is too large", 413);
    if (e instanceof RateLimited) return fail(e.message, 429);
    if (e instanceof InvalidPhoto) {
      return fail(e.reason === "too_large" ? "That photo is too large" : "That does not look like a photo", e.reason === "too_large" ? 413 : 400);
    }
    console.error("Catch failed", describeError(e));
    return fail("Could not save that photo", 500);
  }
}
