import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { execFileSync } from "node:child_process";
import type { AiRequest } from "./types";

export const DEFAULT_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_REGION = "ap-southeast-1";
const MAX_TOKENS = 8000;
const CREDENTIAL_TTL_MS = 10 * 60_000;

/** Models that accept output_config.effort. Haiku 4.5 and Sonnet 4.5 reject it. */
const EFFORT_MODELS = ["claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6"];

export function supportsEffort(model: string): boolean {
  return EFFORT_MODELS.some((m) => model.includes(m));
}

export function bedrockModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.AI_MODEL?.trim();
  return m ? m : DEFAULT_MODEL;
}

export type BedrockParams = Anthropic.MessageCreateParamsNonStreaming;

export function buildBedrockParams(req: AiRequest, model: string): BedrockParams {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: req.system,
    output_config: supportsEffort(model)
      ? { effort: req.effort, format: zodOutputFormat(req.schema) }
      : { format: zodOutputFormat(req.schema) },
    messages: [
      {
        role: "user",
        content: [
          ...req.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/jpeg" as const, data: img.toString("base64") },
          })),
          { type: "text" as const, text: req.text },
        ],
      },
    ],
  };
}

type Keys = { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };

/** `aws login` sessions are not read by the SDK's default chain, so development asks the AWS CLI. */
function exportWithAwsCli(profile: string): Keys {
  const out = execFileSync("aws", ["configure", "export-credentials", "--profile", profile, "--format", "process"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  });
  return JSON.parse(out) as Keys;
}

/**
 * Returns a getter for a Bedrock client. In production it uses the standard credential chain (env
 * or IAM role) and never shells out. In development with AWS_PROFILE it exports short-lived keys
 * through the AWS CLI and rebuilds the client every 10 minutes.
 */
export function createBedrockClient(deps?: {
  env?: NodeJS.ProcessEnv;
  exportCredentials?: (profile: string) => Keys;
  now?: () => number;
}): () => AnthropicBedrock {
  const env = deps?.env ?? process.env;
  const exportCredentials = deps?.exportCredentials ?? exportWithAwsCli;
  const now = deps?.now ?? Date.now;
  const awsRegion = env.AWS_REGION?.trim() || DEFAULT_REGION;
  let client: AnthropicBedrock | null = null;
  let builtAt = 0;
  return () => {
    const profile = env.AWS_PROFILE?.trim();
    const viaCli = env.NODE_ENV !== "production" && !!profile;
    if (client && (!viaCli || now() - builtAt < CREDENTIAL_TTL_MS)) return client;
    if (viaCli) {
      const keys = exportCredentials(profile);
      client = new AnthropicBedrock({
        awsRegion,
        awsAccessKey: keys.AccessKeyId,
        awsSecretKey: keys.SecretAccessKey,
        awsSessionToken: keys.SessionToken,
      });
    } else {
      client = new AnthropicBedrock({ awsRegion });
    }
    builtAt = now();
    return client;
  };
}
