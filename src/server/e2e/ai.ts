import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AiResponse, AiTransport } from "../ai/client";
import { DEMO_CLINIC_NAME } from "../demoPersonas";
import { manilaDate } from "../public";
import { log } from "./paypal";

/*
 * The fake AI for the end-to-end test, as one AiTransport. It answers the three vision requests and the
 * treasurer's turns, and nothing else. It never sees a real model: a photo reads as a plain tabby, and a
 * receipt reads as a receipt for as many pesos as the image is pixels wide, so the test controls the total
 * by the size of the picture it uploads. The treasurer does what the system prompt asks for, one tool at
 * a time, and every tool it calls is the real tool behind the real money gate.
 */

const NAMES = ["Mocha", "Tikoy", "Biscoy", "Luya", "Kulot", "Pugita", "Sinta", "Bagwis"];

const text = (value: unknown): AiResponse => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(value) }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

type Block = { type: string; [k: string]: unknown };
type Message = { role: string; content: string | Block[] };
type Params = { system?: unknown; tools?: unknown[]; messages: Message[] };

const systemText = (p: Params): string =>
  typeof p.system === "string" ? p.system : Array.isArray(p.system) ? p.system.map((b) => (b as { text?: string }).text ?? "").join("\n") : "";

const lastUserText = (p: Params): string => {
  const content = p.messages.at(-1)?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((b) => (b.type === "text" ? String(b.text) : "")).join("\n");
};

function assessment(p: Params) {
  const taken = /Taken names[^:]*: ([^\n]*)\./.exec(lastUserText(p))?.[1].split(", ") ?? [];
  const name = NAMES.find((n) => !taken.some((t) => t.toLowerCase() === n.toLowerCase())) ?? "Little stray";
  return {
    is_cat: true,
    cat_visible_quality: "good",
    reject_reason: "none",
    coat_pattern: "tabby",
    colors: ["orange", "white"],
    markings: "Orange tabby with a white chest.",
    flags: { kitten: false, pregnant: false, injured: false, sick: false },
    probably_female_by_coat: false,
    suggested_name: name,
    short_bio: "A calm orange tabby who watches the street from a wall.",
    // An empty list plus no_sensitive_content lets the photo be published after the real scrubbing step.
    sensitive_regions: [],
    no_sensitive_content: true,
  };
}

async function receipt(p: Params) {
  const last = p.messages.at(-1)?.content;
  const image = Array.isArray(last) ? last.find((b) => b.type === "image") : undefined;
  const data = (image?.source as { data?: string } | undefined)?.data;
  if (!data) throw new Error("No image in the receipt request");
  const buf = Buffer.from(data, "base64");
  const meta = await sharp(buf).metadata();
  return {
    clinic: DEMO_CLINIC_NAME,
    date: manilaDate(new Date()),
    total_centavos: (meta.width ?? 0) * 100,
    currency: "PHP",
    receipt_number: `E2E-${createHash("sha1").update(buf).digest("hex").slice(0, 10)}`,
    cat_name: null,
    items: ["Spay or neuter surgery", "Anti-rabies vaccine", "Deworming"],
    tamper_signs: [],
  };
}

// ---------- The treasurer ----------

type Step = { name: string; input: unknown; ok: boolean; data: Record<string, unknown> };

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((b) => ((b as Block).type === "text" ? String((b as Block).text) : "")).join("") : "";
}

/** Every tool call so far with what came back, in order. */
function trail(messages: Message[]): Step[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  const steps: Step[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") calls.set(String(b.id), { name: String(b.name), input: b.input });
      if (b.type === "tool_result") {
        const call = calls.get(String(b.tool_use_id));
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(resultText(b.content)) as Record<string, unknown>;
        } catch {
          // A result that is not JSON is read as no data.
        }
        if (call) steps.push({ ...call, ok: b.is_error !== true && data.ok !== false, data });
      }
    }
  }
  return steps;
}

const say = (words: string): AiResponse => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: words }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

const call = (n: number, name: string, input: object): AiResponse => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: `toolu_e2e_${n}`, name, input } as AiResponse["content"][number]],
  usage: { input_tokens: 1, output_tokens: 1 },
});

type WaitingCat = { catId: string; name: string };
type OpenBooking = {
  bookingId: string;
  catName: string;
  depositStatus: string;
  depositPaid: number;
  receiptVerified: boolean;
  balanceDue: number | null;
  balanceStatus: string;
};

function funding(steps: Step[]): AiResponse {
  const last = steps.at(-1);
  const n = steps.length + 1;
  if (!last || last.name === "fund_next_cat") return call(n, "get_pool_status", {});
  if (last.name === "get_pool_status") return call(n, "list_waiting_cats", {});
  const pool = [...steps].reverse().find((s) => s.name === "get_pool_status")?.data as { available?: number; packagePrice?: number } | undefined;
  const cats = (last.data.cats as WaitingCat[] | undefined) ?? [];
  if (cats.length === 0) return say("No cat is waiting for funding, so there is nothing to do.");
  const top = cats[0];
  if ((pool?.available ?? 0) < (pool?.packagePrice ?? Infinity)) {
    // A pushy treasurer: it asks for the funding anyway, once, so the test proves the real tool says no
    // and does not depend on this fake choosing to wait.
    if (steps.some((s) => s.name === "fund_next_cat")) return say("The pool cannot cover another care package yet, so I am waiting for more gifts.");
    return call(n, "fund_next_cat", { cat_id: top.catId, reason: `${top.name} is first in line, so ${top.name} is funded now, whatever the pool says.` });
  }
  return call(n, "fund_next_cat", {
    cat_id: top.catId,
    reason: `${top.name} is first in line and the fund can cover the care, so ${top.name} is funded now.`,
  });
}

function bookings(steps: Step[]): AiResponse {
  const last = steps.at(-1);
  const n = steps.length + 1;
  if (!last) return call(n, "list_open_bookings", {});
  if (last.name !== "list_open_bookings") return say("That step is done.");
  const open = (last.data.bookings as OpenBooking[] | undefined) ?? [];
  const needsDeposit = open.find((b) => b.depositStatus === "none");
  if (needsDeposit) {
    return call(n, "pay_vet_deposit", {
      booking_id: needsDeposit.bookingId,
      reason: `The vet visit for ${needsDeposit.catName} is confirmed, so the deposit goes out now.`,
    });
  }
  const needsBalance = open.find((b) => b.receiptVerified && b.depositPaid > 0 && b.balanceStatus === "none" && (b.balanceDue ?? 0) > 0);
  if (needsBalance) {
    return call(n, "release_vet_balance", {
      booking_id: needsBalance.bookingId,
      reason: `The receipt for ${needsBalance.catName} is checked and the deposit is paid, so the balance goes out now.`,
    });
  }
  return say("Nothing is due on the open bookings.");
}

function treasurer(p: Params): AiResponse {
  const first = p.messages[0]?.content;
  const kind = /^Event: ([a-z_]+)\./.exec(typeof first === "string" ? first : "")?.[1] ?? "";
  const steps = trail(p.messages);
  // The test reads this to see what the real fund_next_cat answered, so it proves the rule and not the fake's choice.
  const lastStep = steps.at(-1);
  if (lastStep?.name === "fund_next_cat") log({ call: "treasurer.fund_next_cat", ok: lastStep.ok, code: lastStep.data.code ?? null });
  if (steps.at(-1)?.ok === false) return say("A step was refused, so I am stopping. A caretaker can look at it.");
  return kind === "donation_captured" || kind === "cat_queued" ? funding(steps) : bookings(steps);
}

export const fakeAiTransport: AiTransport = async (params) => {
  const p = params as unknown as Params;
  if (Array.isArray(p.tools) && p.tools.length > 0) return treasurer(p);
  const system = systemText(p);
  if (system.startsWith("You look at one photo taken by a volunteer")) return text(assessment(p));
  if (system.startsWith("You decide whether a new photo shows the same cat")) {
    return text({ match_cat_id: null, confidence: 0, reason: "The fake AI never matches." });
  }
  if (system.startsWith("You read a photo of a veterinary clinic receipt")) return text(await receipt(p));
  throw new Error("The fake AI was asked something it does not know");
};
