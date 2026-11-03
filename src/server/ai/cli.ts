import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import type { AiRequest, FailureReason } from "./types";

export const CLI_TIMEOUT_MS = 120_000;
export const CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const CLI_MAX_CONCURRENT = 2;
export const DEFAULT_CLI_MODEL = "haiku";

/** Only these variables reach the child. Credentials for AWS, PayPal, the database and the session never do. */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
];

export type CliExecOptions = {
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
  killSignal: NodeJS.Signals;
  /** Aborting kills the child. */
  signal?: AbortSignal;
};
export type CliExec = (file: string, args: string[], opts: CliExecOptions) => Promise<{ stdout: string; stderr: string }>;

/** execFile with an argument array and no shell. stdin is closed so the child never waits on it. */
const realExec: CliExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...opts, env: opts.env as NodeJS.ProcessEnv, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });

let exec: CliExec = realExec;

export function setCliExecForTests(fn: CliExec | null): void {
  exec = fn ?? realExec;
}

export type CliOutcome = { ok: true; value: unknown } | { ok: false; reason: FailureReason };

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < CLI_MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // the slot passes straight to the next caller
  else active--;
}

export function childEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = src[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function logFailure(e: unknown): void {
  // Class and exit code only. Never the message, stdout, stderr or any image text.
  const err = e as { code?: unknown; signal?: unknown; killed?: unknown } | null;
  const name = e instanceof Error ? e.constructor.name : typeof e;
  const code = typeof err?.code === "number" || typeof err?.code === "string" ? ` code=${err.code}` : "";
  const sig = typeof err?.signal === "string" ? ` signal=${err.signal}` : "";
  console.error(`[ai] cli failed: ${name}${code}${sig}`);
}

function logResult(kind: string): void {
  console.error(`[ai] cli result: ${kind}`);
}

function readJson(stdout: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(stdout);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function classify(res: Record<string, unknown>): CliOutcome {
  if (res.stop_reason === "refusal" || res.subtype === "refusal") return { ok: false, reason: "refusal" };
  if (res.subtype === "error_max_structured_output_retries") {
    logResult("structured_output_retries");
    return { ok: false, reason: "unparseable" };
  }
  if (res.is_error === true) {
    // Rate limits, auth problems and any other run error. Status only, never the text.
    logResult(`error status=${typeof res.api_error_status === "number" ? res.api_error_status : "none"}`);
    return { ok: false, reason: "unavailable" };
  }
  if (res.structured_output === undefined || res.structured_output === null) return { ok: false, reason: "unparseable" };
  return { ok: true, value: res.structured_output };
}

/** The CLI validates with an older draft and rejects the $schema URI zod writes, so it is dropped. */
function jsonSchemaFor(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return JSON.stringify(json);
}

function promptFor(files: string[], text: string): string {
  const lead =
    files.length === 1
      ? `Image file: ${files[0]}. Read it with the Read tool before answering.`
      : `Image files, in order: ${files.join(", ")}. Read each with the Read tool before answering.`;
  return `${lead}\n\n${text}`;
}

/**
 * One bare call to the local `claude` CLI with no tools at all, run in a fresh empty directory.
 * Returns stdout. Throws on a timeout, a non-zero exit or a missing binary, with nothing quoted.
 */
export async function runClaudeText(args: string[], signal?: AbortSignal): Promise<string> {
  await acquire();
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "stray-ai-"));
    await chmod(dir, 0o700);
    try {
      const { stdout } = await exec("claude", args, {
        cwd: dir,
        env: childEnv(),
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        ...(signal ? { signal } : {}),
      });
      return stdout;
    } catch (e) {
      logFailure(e);
      throw new Error("The claude CLI call failed");
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

/**
 * One call to the local `claude` CLI, on the developer's subscription. The child can only use the
 * Read tool, runs in restricted mode, and sees only a fresh private directory holding the images.
 */
export async function runCli(req: AiRequest, model: string): Promise<CliOutcome> {
  await acquire();
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "stray-ai-"));
    await chmod(dir, 0o700);
    const files = req.images.map((_, i) => `img-${i + 1}.jpg`);
    await Promise.all(req.images.map((img, i) => writeFile(path.join(/*turbopackIgnore: true*/ dir!, files[i]), img, { mode: 0o600 })));

    const args = [
      "-p",
      promptFor(files, req.text),
      "--output-format",
      "json",
      "--json-schema",
      jsonSchemaFor(req.schema),
      "--model",
      model,
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--restricted",
      "--disable-slash-commands",
      "--safe-mode",
      "--system-prompt",
      req.system,
    ];

    let stdout: string;
    try {
      ({ stdout } = await exec("claude", args, {
        cwd: dir,
        env: childEnv(),
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
      }));
    } catch (e) {
      logFailure(e);
      return { ok: false, reason: "unavailable" };
    }

    const res = readJson(stdout);
    if (!res) {
      logResult("not_json");
      return { ok: false, reason: "unparseable" };
    }
    return classify(res);
  } catch (e) {
    logFailure(e);
    return { ok: false, reason: "unavailable" };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}
