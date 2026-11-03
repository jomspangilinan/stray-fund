import { UNTRUSTED_IMAGE_TEXT, parseVision, type Result } from "./client";
import { MatchSchema, type MatchResult } from "./schemas";

export const MAX_CANDIDATES = 6;
const MAX_PHOTOS_PER_CANDIDATE = 3;

const SYSTEM = `You decide whether a new photo shows the same cat as one of several known cats.

${UNTRUSTED_IMAGE_TEXT}

Rules:
- The first image is the new photo. The remaining images belong to the labelled candidate cats, in the order described in the message.
- Photos of the same cat vary with light, angle and pose. Compare coat pattern, markings, face and ear shape, not brightness.
- When you are unsure, return match_cat_id null with low confidence. Wrongly merging two different cats is worse than creating a duplicate card.
- match_cat_id must be exactly one of the candidate ids given, or null.
- Keep reason to one short sentence.`;

export async function matchCat(
  jpeg: Buffer,
  candidates: { catId: string; photos: Buffer[] }[],
): Promise<Result<MatchResult>> {
  const usable = candidates
    .filter((c) => c.photos.length > 0)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ catId: c.catId, photos: c.photos.slice(0, MAX_PHOTOS_PER_CANDIDATE) }));

  if (usable.length === 0) {
    return { ok: true, data: { match_cat_id: null, confidence: 0, reason: "No candidates to compare." } };
  }

  const images: Buffer[] = [jpeg];
  const lines: string[] = ["Image 1 is the new photo."];
  for (const c of usable) {
    const first = images.length + 1;
    images.push(...c.photos);
    const last = images.length;
    lines.push(`Candidate id "${c.catId}": ${first === last ? `image ${first}` : `images ${first} to ${last}`}.`);
  }
  lines.push("Is the new photo one of these cats?");

  const res = await parseVision({
    system: SYSTEM,
    images,
    text: lines.join("\n"),
    schema: MatchSchema,
    effort: "medium",
  });
  if (!res.ok) return res;

  // Model output is untrusted. An id we did not offer is never a match.
  if (res.data.match_cat_id !== null && !usable.some((c) => c.catId === res.data.match_cat_id)) {
    return {
      ok: true,
      data: { match_cat_id: null, confidence: 0, reason: "Model named a cat that was not a candidate." },
    };
  }
  return res;
}
