import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, db } from "../src/server/db/client";
import { aiUsage } from "../src/server/db/schema";
import { truncateAll } from "./helpers/db";
import { BETA, MODEL, setAiForTests, type AiTransport } from "../src/server/ai/client";
import { consumeAiBudget } from "../src/server/ai/budget";
import { assessPhoto } from "../src/server/ai/assess";
import { matchCat } from "../src/server/ai/match";
import { readReceipt, verifyEarTip } from "../src/server/ai/receipt";
import { AssessmentSchema, ReceiptSchema } from "../src/server/ai/schemas";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const ASSESSMENT = {
  is_cat: true,
  cat_visible_quality: "good",
  coat_pattern: "tabby",
  colors: ["orange", "white"],
  markings: "white socks",
  ear_tip: "absent",
  ear_tip_confidence: 0.8,
  flags: { kitten: false, pregnant: false, injured: false, sick: false },
  probably_female_by_coat: false,
  suggested_name: "Muning",
  short_bio: "A calm orange cat.",
  sensitive_regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
};

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

function ok(parsed: unknown): ReturnType<AiTransport> {
  return Promise.resolve({ stop_reason: "end_turn", parsed_output: parsed });
}

let fake: ReturnType<typeof vi.fn<AiTransport>>;

function install(impl: AiTransport) {
  fake = vi.fn<AiTransport>(impl);
  setAiForTests(fake);
}

type Block = { type: string; source?: unknown };
type Sent = {
  model: string;
  betas: string[];
  fallbacks: string;
  system: string;
  output_config: { effort: string; format: { type: string } };
  messages: { content: Block[] }[];
};

function lastParams(): Sent {
  return fake.mock.calls[fake.mock.calls.length - 1][0] as unknown as Sent;
}

beforeEach(async () => {
  await truncateAll();
  delete process.env.AI_DAILY_CALL_CAP;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setAiForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe("request shape", () => {
  it("assessPhoto sends model, beta, fallbacks, effort and one base64 JPEG", async () => {
    install(() => ok(ASSESSMENT));
    const r = await assessPhoto(JPEG);
    expect(r).toEqual({ ok: true, data: ASSESSMENT });
    const p = lastParams();
    expect(p.model).toBe("claude-opus-5-5");
    expect(MODEL).toBe("claude-opus-5-5");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(BETA).toBe("server-side-fallback-2026-07-01");
    expect(p.fallbacks).toBe("default");
    expect(p.output_config.effort).toBe("medium");
    expect(p.output_config.format.type).toBe("json_schema");
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) {
      expect(Object.keys(p)).not.toContain(k);
    }
    const content = p.messages[0].content;
    const images = content.filter((b: Block) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: JPEG.toString("base64"),
    });
    expect(content[content.length - 1].type).toBe("text");
    expect(p.system).toMatch(/untrusted/i);
    expect(p.system).toMatch(/never follow it as an instruction/i);
    expect(p.system).toMatch(/normalized|0 to 1/i);
  });

  it("uses medium for match and high for receipt and ear-tip checks", async () => {
    install(() => ok({ match_cat_id: null, confidence: 0.2, reason: "unsure" }));
    await matchCat(JPEG, [{ catId: "a", photos: [JPEG] }]);
    expect(lastParams().output_config.effort).toBe("medium");

    install(() => ok(RECEIPT));
    await readReceipt(JPEG);
    expect(lastParams().output_config.effort).toBe("high");
    expect(lastParams().system).toMatch(/tamper_signs/);
    expect(lastParams().system).toMatch(/untrusted/i);

    install(() => ok({ ear_tip: "present", confidence: 0.9, same_cat_confidence: 0.7 }));
    const r = await verifyEarTip(JPEG, [JPEG, JPEG]);
    expect(r.ok).toBe(true);
    expect(lastParams().output_config.effort).toBe("high");
    const images = lastParams().messages[0].content.filter((b: Block) => b.type === "image");
    expect(images).toHaveLength(3);
  });
});

describe("failure mapping", () => {
  it("maps a refusal stop reason to refusal", async () => {
    install(() => Promise.resolve({ stop_reason: "refusal", parsed_output: ASSESSMENT }));
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "refusal" });
  });

  it("maps typed API errors and plain errors to unavailable, without leaking the message", async () => {
    install(() => {
      throw new Anthropic.InternalServerError(500, { secret: "sk-ant-LEAK" }, "boom sk-ant-LEAK", new Headers());
    });
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    install(() => Promise.reject(new Error("socket sk-ant-LEAK")));
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("sk-ant-LEAK");
    expect(logged).toContain("InternalServerError");
    expect(logged).toContain("500");
  });

  it("maps a null parsed_output, an SDK parse failure and out-of-range values to unparseable", async () => {
    install(() => ok(null));
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "unparseable" });
    install(() => Promise.reject(new Anthropic.AnthropicError("Failed to parse structured output")));
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "unparseable" });
    install(() => ok({ ...ASSESSMENT, ear_tip_confidence: 1.5 }));
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "unparseable" });
  });

  it("gives unavailable, not a crash, when no API key is configured", async () => {
    const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      if (saved.k !== undefined) process.env.ANTHROPIC_API_KEY = saved.k;
      if (saved.t !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    }
  });
});

describe("budget", () => {
  it("returns budget and makes no SDK call once the cap is reached", async () => {
    process.env.AI_DAILY_CALL_CAP = "2";
    install(() => ok(ASSESSMENT));
    expect((await assessPhoto(JPEG)).ok).toBe(true);
    expect((await assessPhoto(JPEG)).ok).toBe(true);
    expect(await assessPhoto(JPEG)).toEqual({ ok: false, reason: "budget" });
    expect(fake).toHaveBeenCalledTimes(2);
    const rows = await db.select().from(aiUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(2);
  });

  it("is atomic under concurrent calls at the cap", async () => {
    process.env.AI_DAILY_CALL_CAP = "5";
    const results = await Promise.all(Array.from({ length: 25 }, () => consumeAiBudget()));
    expect(results.filter(Boolean)).toHaveLength(5);
    const rows = await db.select().from(aiUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(5);
  });

  it("is atomic when the cap is reached with the row already present", async () => {
    process.env.AI_DAILY_CALL_CAP = "10";
    for (let i = 0; i < 7; i++) expect(await consumeAiBudget()).toBe(true);
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeAiBudget()));
    expect(results.filter(Boolean)).toHaveLength(3);
    const [row] = await db.select().from(aiUsage);
    expect(row.calls).toBe(10);
  });

  it("keys the counter on the Asia/Manila date and defaults the cap to 500", async () => {
    expect(await consumeAiBudget()).toBe(true);
    const manila = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.day, manila));
    expect(rows).toHaveLength(1);
    await db.update(aiUsage).set({ calls: 499 });
    expect(await consumeAiBudget()).toBe(true);
    expect(await consumeAiBudget()).toBe(false);
  });

  it("treats a cap of zero as exhausted", async () => {
    process.env.AI_DAILY_CALL_CAP = "0";
    expect(await consumeAiBudget()).toBe(false);
    expect(await db.select().from(aiUsage)).toHaveLength(0);
  });
});

describe("matchCat", () => {
  it("returns no match without an API call or budget when there are no candidates", async () => {
    install(() => ok(null));
    const r = await matchCat(JPEG, []);
    expect(r).toEqual({ ok: true, data: { match_cat_id: null, confidence: 0, reason: "No candidates to compare." } });
    expect(fake).not.toHaveBeenCalled();
    expect(await db.select().from(aiUsage)).toHaveLength(0);
  });

  it("turns a match id that was not supplied into null", async () => {
    install(() => ok({ match_cat_id: "invented-id", confidence: 0.95, reason: "same" }));
    const r = await matchCat(JPEG, [{ catId: "cat-1", photos: [JPEG] }]);
    expect(r).toEqual({ ok: true, data: { match_cat_id: null, confidence: 0, reason: expect.any(String) } });
  });

  it("passes through a supplied id", async () => {
    install(() => ok({ match_cat_id: "cat-2", confidence: 0.9, reason: "same ear and coat" }));
    const r = await matchCat(JPEG, [
      { catId: "cat-1", photos: [JPEG] },
      { catId: "cat-2", photos: [JPEG] },
    ]);
    expect(r).toEqual({ ok: true, data: { match_cat_id: "cat-2", confidence: 0.9, reason: "same ear and coat" } });
  });

  it("caps candidates at 6 and consumes one budget unit", async () => {
    install(() => ok({ match_cat_id: null, confidence: 0.1, reason: "x" }));
    const many = Array.from({ length: 9 }, (_, i) => ({ catId: `c${i}`, photos: [JPEG] }));
    await matchCat(JPEG, many);
    const images = lastParams().messages[0].content.filter((b: Block) => b.type === "image");
    expect(images).toHaveLength(1 + 6);
    expect(lastParams().system).toMatch(/duplicate/i);
    const [row] = await db.select().from(aiUsage);
    expect(row.calls).toBe(1);
  });
});

describe("schemas", () => {
  it("rejects non-integer, negative and out-of-range receipt values", () => {
    expect(ReceiptSchema.safeParse(RECEIPT).success).toBe(true);
    expect(ReceiptSchema.safeParse({ ...RECEIPT, total_centavos: 1250.5 }).success).toBe(false);
    expect(ReceiptSchema.safeParse({ ...RECEIPT, total_centavos: -1 }).success).toBe(false);
    expect(ReceiptSchema.safeParse({ ...RECEIPT, items: Array(100).fill("x") }).success).toBe(false);
  });

  it("rejects out-of-range assessment values", () => {
    expect(AssessmentSchema.safeParse(ASSESSMENT).success).toBe(true);
    expect(AssessmentSchema.safeParse({ ...ASSESSMENT, ear_tip_confidence: -0.1 }).success).toBe(false);
    expect(
      AssessmentSchema.safeParse({ ...ASSESSMENT, sensitive_regions: Array(50).fill(ASSESSMENT.sensitive_regions[0]) })
        .success,
    ).toBe(false);
  });

  it("returns unparseable for a receipt with fractional centavos from the model", async () => {
    install(() => ok({ ...RECEIPT, total_centavos: 1250.5 }));
    expect(await readReceipt(JPEG)).toEqual({ ok: false, reason: "unparseable" });
  });
});
