import type * as z from "zod/v4";

export type Effort = "low" | "medium" | "high";

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "refusal" | "budget" | "unavailable" | "unparseable" };

export type FailureReason = "refusal" | "unavailable" | "unparseable";

/** One vision request, independent of the transport that carries it. */
export type AiRequest = {
  system: string;
  images: Buffer[];
  text: string;
  schema: z.ZodType;
  effort: Effort;
};
