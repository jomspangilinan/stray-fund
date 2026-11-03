import { NextResponse } from "next/server";
import { RateLimited } from "@/server/spot";
import { describeError } from "@/server/errors";
import { BodyTooLarge, parseForm, readLimited } from "@/server/http";
import { InvalidPhoto, MAX_BYTES } from "@/server/photos";
import { isUuid } from "@/server/public";
import { AuthError, requireRole } from "@/server/session";
import { assertCanSubmitEvidence, reasonMessages, submitEvidence, VetFlowError, type Verification } from "@/server/vetFlow";

// Room for the multipart envelope around two files that are each at most MAX_BYTES.
const MAX_BODY = 2 * MAX_BYTES + 64 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const SUMMARY: Record<Verification, string> = {
  verified: "Verified. The balance is on its way to you, and the cat's card has been updated.",
  needs_review: "We could not confirm this automatically, so a caretaker will look at it. The balance waits until then. You can also send a new photo.",
  rejected: "This submission was refused and nothing was paid.",
  pending: "Saved. We could not finish checking it just now, and will try again soon. You do not need to send it again.",
};

/** Multipart form: receipt (JPEG or PNG), earTipPhoto (JPEG from the live camera). The answer holds fixed words only. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole("vet");
    const { id } = await ctx.params;
    if (!isUuid(id)) return fail("There is no such booking", 404);
    // Checked before the body is read, so someone else's booking or a flood is cheap to refuse.
    await assertCanSubmitEvidence(session.userId, id);

    const form = await parseForm(req, await readLimited(req, MAX_BODY));
    if (!form) return fail("Send the photos as a form", 400);

    const receipt = form.get("receipt");
    const ear = form.get("earTipPhoto");
    if (!(receipt instanceof Blob) || receipt.size === 0) return fail("A photo of the receipt is required", 400);
    if (!(ear instanceof Blob) || ear.size === 0) return fail("A photo of the cat's ears is required", 400);
    if (receipt.size > MAX_BYTES || ear.size > MAX_BYTES) return fail("That photo is too large", 413);
    if (receipt.type !== "image/jpeg" && receipt.type !== "image/png") return fail("The receipt must be a JPEG or PNG", 415);
    if (ear.type !== "image/jpeg") return fail("The ear photo must be a JPEG", 415);

    const receiptBytes = Buffer.from(await receipt.arrayBuffer());
    const earBytes = Buffer.from(await ear.arrayBuffer());
    // The type above is only a label from the client.
    if (!isJpeg(receiptBytes) && !isPng(receiptBytes)) return fail("The receipt must be a JPEG or PNG", 415);
    if (!isJpeg(earBytes)) return fail("The ear photo must be a JPEG", 415);

    const out = await submitEvidence({ vetId: session.userId, bookingId: id, receipt: receiptBytes, earTipPhoto: earBytes });
    return NextResponse.json(
      {
        verification: out.verification,
        reasons: out.reasons,
        message: SUMMARY[out.verification],
        messages: reasonMessages(out.reasons),
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, e.status);
    if (e instanceof VetFlowError) return fail(e.message, e.status);
    if (e instanceof BodyTooLarge) return fail("That photo is too large", 413);
    if (e instanceof RateLimited) return fail("Too many submissions in the last minute. Wait a moment and try again.", 429);
    if (e instanceof InvalidPhoto) {
      return e.reason === "too_large" ? fail("That photo is too large", 413) : fail("That does not look like a photo", 400);
    }
    console.error("Evidence failed", describeError(e));
    return fail("Could not save the evidence", 500);
  }
}
