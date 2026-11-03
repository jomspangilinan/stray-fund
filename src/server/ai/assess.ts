import { BOX_NOTE, UNTRUSTED_IMAGE_TEXT, parseVision, type Result } from "./client";
import { AssessmentSchema, type Assessment } from "./schemas";

export type { Assessment };

const SYSTEM = `You look at one photo taken by a volunteer who feeds community cats, and fill in a short structured record.

${UNTRUSTED_IMAGE_TEXT}

Rules:
- is_cat is true only if a real cat is clearly in the photo. Dogs, toys, drawings and screens showing cats are not cats.
- cat_visible_quality is "poor" when the cat is blurred, tiny, mostly hidden or too dark to identify later.
- reject_reason says why the photo cannot be used, and is "none" when is_cat is true and cat_visible_quality is "good". Otherwise pick the closest one: "screen_or_picture" for a photo of a screen, print or drawing, "no_cat" when there is simply no cat, "too_dark", "too_blurry", "too_far" for a tiny cat, or "cat_hidden" when most of the cat is covered or out of frame.
- Never guess sex from the photo. Set probably_female_by_coat to true only for a clear calico or tortoiseshell coat, otherwise false.
- flags: set kitten, pregnant, injured or sick to true only when it is plainly visible.
- sensitive_regions: boxes around human faces, number plates and street signs or house numbers, so they can be blurred. ${BOX_NOTE} Use an empty list when there are none.
- suggested_name: one kind, simple, Filipino-friendly name, such as Muning, Mingming, Tigre or Bituin.
- short_bio: one or two gentle sentences about how the cat looks. Do not invent a location or a history.
- Keep colors to plain words.`;

export function assessPhoto(jpeg: Buffer): Promise<Result<Assessment>> {
  return parseVision({
    system: SYSTEM,
    images: [jpeg],
    text: "Describe this photo using the required fields.",
    schema: AssessmentSchema,
    effort: "medium",
  });
}
