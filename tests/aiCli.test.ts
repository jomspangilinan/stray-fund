import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, db } from "../src/server/db/client";
import { aiUsage } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { resolveProvider, setAiForTests } from "../src/server/ai/client";
import { setCliExecForTests, type CliExec } from "../src/server/ai/cli";
import { assessPhoto } from "../src/server/ai/assess";
import { readReceipt } from "../src/server/ai/receipt";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const RECEIPT = {
  clinic: "Happy Paws",
  date: "2026-11-02",
  total_centavos: 125000,
  currency: "PHP",
  receipt_number: "A-1",
  cat_name: "Muning",
  items: ["Neuter"],
  tamper_signs: [],
};

/** What `claude -p --output-format json` prints on success. */
function cliOut(value: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: value, ...extra });
}

type Call = { file: string; args: string[]; opts: Parameters<CliExec>[2] };
let calls: Call[];
let fake: ReturnType<typeof vi.fn<CliExec>>;

function install(impl: CliExec) {
  calls = [];
  fake = vi.fn<CliExec>(async (file, args, opts) => {
    calls.push({ file, args, opts });
    return impl(file, args, opts);
  });
  setCliExecForTests(fake);
}

const okExec = (value: unknown = RECEIPT): CliExec => async () => ({ stdout: cliOut(value), stderr: "" });

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-LEAK",
  AWS_SECRET_ACCESS_KEY: "aws-LEAK",
  AWS_ACCESS_KEY_ID: "aws-id-LEAK",
  AWS_PROFILE: "profile-LEAK",
  SESSION_SECRET: "session-LEAK",
  PAYPAL_CLIENT_SECRET: "paypal-LEAK",
  FEEDER_TOKEN: "feeder-LEAK",
};

beforeEach(async () => {
  await truncateAll();
  delete process.env.AI_DAILY_CALL_CAP;
  vi.stubEnv("AI_PROVIDER", "claude-cli");
  vi.stubEnv("AI_CLI_MODEL", "");
  for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setAiForTests(null);
  setCliExecForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe("claude-cli request", () => {
  it("runs claude with an exact argument array, no shell, a 120 second timeout and a size cap", async () => {
    install(okExec());
    const r = await readReceipt(JPEG);
    expect(r).toEqual({ ok: true, data: RECEIPT });
    expect(calls).toHaveLength(1);
    const { file, args, opts } = calls[0];
    expect(file).toBe("claude");
    const schemaArg = args[args.indexOf("--json-schema") + 1];
    const schema = JSON.parse(schemaArg);
    expect(schema.properties.total_centavos).toBeDefined();
    // The CLI validates with an older draft and rejects a $schema URI it does not know.
    expect(schema).not.toHaveProperty("$schema");
    const sys = args[args.indexOf("--system-prompt") + 1];
    expect(sys).toMatch(/veterinary clinic receipt/);
    expect(sys).toMatch(/untrusted/i);
    expect(args).toEqual([
      "-p",
      expect.stringMatching(/^Image file: img-1\.jpg\./),
      "--output-format",
      "json",
      "--json-schema",
      schemaArg,
      "--model",
      "haiku",
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--restricted",
      "--disable-slash-commands",
      "--system-prompt",
      sys,
    ]);
    expect(opts).not.toHaveProperty("shell");
    expect(opts.timeout).toBe(120_000);
    expect(opts.maxBuffer).toBeGreaterThan(0);
    expect(opts.maxBuffer).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("takes the model from AI_CLI_MODEL", async () => {
    vi.stubEnv("AI_CLI_MODEL", "sonnet");
    install(okExec());
    await readReceipt(JPEG);
    const args = calls[0].args;
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("exposes only the Read tool, never Bash, Write, Edit or web tools", async () => {
    install(okExec());
    await readReceipt(JPEG);
    const args = calls[0].args;
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read");
    const joined = args.join(" ");
    for (const t of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"]) expect(joined).not.toContain(t);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--add-dir");
  });

  it("builds the child env from an allowlist and drops every secret", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("HOME", "/home/dev");
    install(okExec());
    await readReceipt(JPEG);
    const env = calls[0].opts.env as Record<string, string>;
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/dev");
    for (const k of [...Object.keys(SECRETS), "DATABASE_URL", "TEST_DATABASE_URL"]) expect(env).not.toHaveProperty(k);
    expect(JSON.stringify(env)).not.toMatch(/LEAK|postgres/);
  });

  it("writes images into a fresh private temp dir used as cwd and removes it afterwards", async () => {
    let seen: { cwd: string; mode: number; files: string[]; prompt: string } | null = null;
    install(async (_f, args, opts) => {
      const cwd = String(opts.cwd);
      seen = { cwd, mode: statSync(cwd).mode & 0o777, files: readdirSync(cwd).sort(), prompt: args[1] };
      return { stdout: cliOut(RECEIPT), stderr: "" };
    });
    await readReceipt(JPEG);
    expect(seen).not.toBeNull();
    const s = seen!;
    expect(s.mode).toBe(0o700);
    expect(s.files).toEqual(["img-1.jpg"]);
    expect(path.isAbsolute(s.cwd)).toBe(true);
    expect(s.prompt).not.toContain(s.cwd);
    expect(s.prompt).not.toContain("/");
    expect(existsSync(s.cwd)).toBe(false);
  });

  it("numbers several images and names each one relatively", async () => {
    let files: string[] = [];
    let prompt = "";
    install(async (_f, args, opts) => {
      files = readdirSync(String(opts.cwd)).sort();
      prompt = args[1];
      return { stdout: cliOut({ ear_tip: "absent", confidence: 0.5, same_cat_confidence: 0.5 }), stderr: "" };
    });
    const { verifyEarTip } = await import("../src/server/ai/receipt");
    await verifyEarTip(JPEG, [JPEG, JPEG]);
    expect(files).toEqual(["img-1.jpg", "img-2.jpg", "img-3.jpg"]);
    expect(prompt).toMatch(/img-1\.jpg/);
    expect(prompt).toMatch(/img-3\.jpg/);
  });

  it("removes the temp dir when the call fails", async () => {
    let cwd = "";
    install(async (_f, _a, opts) => {
      cwd = String(opts.cwd);
      throw Object.assign(new Error("boom"), { code: 1 });
    });
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    expect(cwd).not.toBe("");
    expect(existsSync(cwd)).toBe(false);
  });
});

describe("claude-cli failure mapping", () => {
  it("maps a timeout kill to unavailable", async () => {
    install(async () => {
      throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
    });
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("maps spawn failure and nonzero exit to unavailable", async () => {
    install(async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    install(async () => {
      throw Object.assign(new Error("exit"), { code: 1, stdout: "{}", stderr: "x" });
    });
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("maps rate limit and auth errors reported in the JSON to unavailable", async () => {
    install(async () => ({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "rate limit" }),
      stderr: "",
    }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    install(async () => ({
      stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "Invalid API key" }),
      stderr: "",
    }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    install(async () => ({
      stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "x" }),
      stderr: "",
    }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("maps non-JSON output, a missing structured output and schema failures to unparseable", async () => {
    install(async () => ({ stdout: "not json at all", stderr: "" }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unparseable" });
    install(async () => ({ stdout: JSON.stringify({ type: "result", is_error: false, result: "prose" }), stderr: "" }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unparseable" });
    install(okExec({ ...RECEIPT, total_centavos: 1250.5 }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unparseable" });
  });

  it("maps a refusal to refusal", async () => {
    install(async () => ({ stdout: cliOut(null, { stop_reason: "refusal", structured_output: undefined }), stderr: "" }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "refusal" });
  });

  it("logs the failure class and exit code only, never output", async () => {
    install(async () => {
      throw Object.assign(new Error("sk-ant-LEAK in message"), { code: 3, stdout: "RECEIPT-TEXT-LEAK", stderr: "sk-ant-LEAK" });
    });
    await readReceipt(JPEG);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toMatch(/LEAK/);
    expect(logged).toContain("code=3");
  });
});

describe("provider selection", () => {
  it("refuses claude-cli in production without spawning anything", async () => {
    vi.stubEnv("NODE_ENV", "production");
    install(okExec());
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("refuses an unknown provider", async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    install(okExec());
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("defaults to claude-cli in development and to bedrock in production", () => {
    expect(resolveProvider({ NODE_ENV: "development" })).toBe("claude-cli");
    expect(resolveProvider({ NODE_ENV: "test", AI_PROVIDER: "" })).toBe("claude-cli");
    expect(resolveProvider({ NODE_ENV: "production" })).toBe("bedrock");
    expect(resolveProvider({ NODE_ENV: "production", AI_PROVIDER: "bedrock" })).toBe("bedrock");
    expect(resolveProvider({ NODE_ENV: "development", AI_PROVIDER: "bedrock" })).toBe("bedrock");
    expect(() => resolveProvider({ NODE_ENV: "production", AI_PROVIDER: "claude-cli" })).toThrow();
    expect(() => resolveProvider({ NODE_ENV: "development", AI_PROVIDER: "nope" })).toThrow();
  });
});

describe("claude-cli budget and concurrency", () => {
  it("consumes the daily budget and stops spawning at the cap", async () => {
    vi.stubEnv("AI_DAILY_CALL_CAP", "1");
    install(okExec());
    expect((await readReceipt(JPEG)).ok).toBe(true);
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "budget" });
    expect(fake).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(aiUsage);
    expect(row.calls).toBe(1);
  });

  it("runs at most 2 children at once in the process", async () => {
    let running = 0;
    let peak = 0;
    install(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 25));
      running--;
      return { stdout: cliOut(RECEIPT), stderr: "" };
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => readReceipt(JPEG)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it("releases its slot when a call fails", async () => {
    install(async () => {
      throw Object.assign(new Error("x"), { code: 1 });
    });
    await Promise.all(Array.from({ length: 5 }, () => assessPhoto(JPEG)));
    install(okExec());
    expect((await readReceipt(JPEG)).ok).toBe(true);
  });
});
