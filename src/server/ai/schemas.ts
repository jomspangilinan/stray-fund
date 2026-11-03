import * as z from "zod/v4";

// The SDK sends these to the API with unsupported keywords (minimum, maximum, maxItems) folded into
// field descriptions, then validates the reply against the full schema client side. parseVision runs
// the schema once more, so an out-of-range value always ends as "unparseable".

const unit = z.number().min(0).max(1);

/** Normalized 0 to 1, x and y are the top left corner. Matches Box in src/server/photos.ts. */
const BoxSchema = z.object({
  x: unit,
  y: unit,
  w: unit,
  h: unit,
});

export const COAT_PATTERNS = [
  "solid",
  "tabby",
  "bicolor",
  "tuxedo",
  "calico",
  "tortoiseshell",
  "colorpoint",
  "other",
] as const;

export const AssessmentSchema = z.object({
  is_cat: z.boolean(),
  cat_visible_quality: z.enum(["good", "poor"]),
  coat_pattern: z.enum(COAT_PATTERNS),
  colors: z.array(z.string().max(30)).max(4),
  markings: z.string().max(200),
  flags: z.object({
    kitten: z.boolean(),
    pregnant: z.boolean(),
    injured: z.boolean(),
    sick: z.boolean(),
  }),
  probably_female_by_coat: z.boolean(),
  suggested_name: z.string().max(30),
  short_bio: z.string().max(280),
  sensitive_regions: z.array(BoxSchema).max(8),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const MatchSchema = z.object({
  match_cat_id: z.string().max(100).nullable(),
  confidence: unit,
  reason: z.string().max(300),
});
export type MatchResult = z.infer<typeof MatchSchema>;

export const ReceiptSchema = z.object({
  clinic: z.string().max(120).nullable(),
  date: z.string().max(40).nullable(),
  total_centavos: z.number().int().min(0).nullable(),
  currency: z.string().max(8).nullable(),
  receipt_number: z.string().max(60).nullable(),
  cat_name: z.string().max(60).nullable(),
  items: z.array(z.string().max(120)).max(30),
  tamper_signs: z.array(z.string().max(200)).max(10),
});
export type ReceiptReading = z.infer<typeof ReceiptSchema>;
