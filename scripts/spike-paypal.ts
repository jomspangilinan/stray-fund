/* eslint-disable @typescript-eslint/no-explicit-any -- raw PayPal JSON in a spike script */
/**
 * PayPal sandbox spike. Sandbox only, run with tsx:
 *   npx tsx scripts/spike-paypal.ts <order|capture|payout|payout-status|duplicate|invalid|toolkit> [arg]
 * Raw responses are scrubbed and saved to tests/fixtures/paypal/.
 * Never prints credentials, tokens or full emails.
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restPayoutGateway } from "../src/server/paypal/payouts";

config({ path: ".env.local" });

const BASE = "https://api-m.sandbox.paypal.com";
if (process.env.PAYPAL_ENV !== "sandbox") {
  console.error("Refusing to run: PAYPAL_ENV must be sandbox");
  process.exit(1);
}
const ID = process.env.PAYPAL_CLIENT_ID ?? "";
const SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
const VET = process.env.PAYPAL_VET_EMAIL ?? "";
if (!ID || !SECRET || !VET) {
  console.error("Missing PayPal env vars");
  process.exit(1);
}
const CUR = process.env.SPIKE_CURRENCY ?? "PHP";
const FIX = join(process.cwd(), "tests/fixtures/paypal");

function maskEmail(e: string): string {
  const [u = "", d = ""] = e.split("@");
  return `${u.slice(0, 1)}***@${d.slice(0, 1)}***`;
}

/** Replace anything personal or account-bound with stable placeholders. */
const fakeIds = new Map<string, string>();
function fake(prefix: string, real: string): string {
  const k = `${prefix}:${real}`;
  if (!fakeIds.has(k)) fakeIds.set(k, `${prefix}_FAKE${String(fakeIds.size + 1).padStart(3, "0")}`);
  return fakeIds.get(k)!;
}
function scrub(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x, k)]),
    );
  }
  if (typeof v !== "string") return v;
  if (/email|receiver/i.test(key) || /@/.test(v)) {
    return v.includes("@") ? "sandbox-user@example.test" : v;
  }
  if (/^(address_line_1|address_line_2|admin_area_1|admin_area_2|postal_code)$/.test(key)) return "REDACTED";
  if (/^(payer_id|merchant_id|account_id|payee_id)$/.test(key)) return fake("ACCT", v);
  if (/^(given_name|surname|full_name|name|recipient_name)$/.test(key) && key !== "name") return "Sandbox Person";
  if (/^(payout_batch_id)$/.test(key)) return fake("BATCH", v);
  if (/^(payout_item_id)$/.test(key)) return fake("ITEM", v);
  if (/^(transaction_id)$/.test(key)) return fake("TXN", v);
  if (/^(id|order_id)$/.test(key)) return fake("ID", v);
  if (/^(debug_id)$/.test(key)) return "DEBUG_FAKE";
  if (/^(href)$/.test(key)) {
    return v.replace(/\/(payouts|payouts-item|orders|captures)\/[A-Z0-9-]+/g, "/$1/FAKE").replace(/token=[A-Z0-9]+/g, "token=FAKE");
  }
  return v;
}
function save(name: string, status: number, body: unknown): void {
  mkdirSync(FIX, { recursive: true });
  writeFileSync(join(FIX, `${name}.json`), JSON.stringify({ status, body: scrub(body) }, null, 2) + "\n");
}

async function token(): Promise<string> {
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`token failed HTTP ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body: json as any };
}
function show(label: string, v: unknown): void {
  console.log(`${label}: ${JSON.stringify(scrub(v), null, 2)}`);
}

async function rawPayout(senderBatchId: string, receiver: string, value: string, currency = CUR, recipientType = "EMAIL") {
  return api("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: senderBatchId },
    items: [{ recipient_type: recipientType, amount: { value, currency }, receiver, note: "spike" }],
  });
}

const [cmd, arg] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case "order": {
      const r = await api("POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: CUR, value: "100.00" } }],
        payment_source: { paypal: { experience_context: { return_url: "https://example.com/return", cancel_url: "https://example.com/cancel", user_action: "PAY_NOW" } } },
      });
      console.log("status", r.status);
      save(`order-create-${CUR}`, r.status, r.body);
      if (r.status >= 300) { show("error", r.body); return; }
      const link = (r.body.links as { rel: string; href: string }[]).find((l) => l.rel === "payer-action" || l.rel === "approve");
      console.log("order id:", r.body.id, "status:", r.body.status);
      console.log("approval link:", link?.href);
      return;
    }
    case "capture": {
      if (!arg) throw new Error("capture <orderId>");
      const r = await api("POST", `/v2/checkout/orders/${arg}/capture`, undefined, { "PayPal-Request-Id": `spike-cap-${arg}` });
      console.log("status", r.status);
      save(`order-capture-${CUR}`, r.status, r.body);
      const cap = r.body?.purchase_units?.[0]?.payments?.captures?.[0];
      show("capture", { id: cap?.id, status: cap?.status, amount: cap?.amount, seller_receivable_breakdown: cap?.seller_receivable_breakdown });
      return;
    }
    case "payout": {
      const sbid = `spike-${Date.now()}`;
      console.log("sender_batch_id:", sbid, "receiver:", maskEmail(VET));
      const res = await restPayoutGateway.create({ senderBatchId: sbid, receiver: VET, amount: 1000, note: "spike" });
      console.log("gateway.create ->", JSON.stringify(res));
      if (res.kind === "sent") {
        console.log("batch id:", res.batchId);
        const raw = await api("GET", `/v1/payments/payouts/${res.batchId}`);
        save(`payout-batch-${CUR}-initial`, raw.status, raw.body);
        console.log("gateway.get ->", JSON.stringify(await restPayoutGateway.get(res.batchId)));
      }
      return;
    }
    case "payout-status": {
      if (!arg) throw new Error("payout-status <batchId>");
      const raw = await api("GET", `/v1/payments/payouts/${arg}`);
      const it = raw.body?.items?.[0];
      console.log("status", raw.status, "batch_status:", raw.body?.batch_header?.batch_status,
        "transaction_status:", it?.transaction_status, "fee:", JSON.stringify(it?.payout_item_fee),
        "items:", raw.body?.items?.length, "total_items:", raw.body?.total_items);
      if (raw.status === 200) save(`payout-batch-${CUR}-${raw.body?.batch_header?.batch_status}-${it?.transaction_status}`, raw.status, raw.body);
      return;
    }
    case "duplicate": {
      if (!arg) throw new Error("duplicate <senderBatchId> [batchId]");
      const batchId = process.argv[4];
      const r = await rawPayout(arg, VET, "10.00");
      console.log("raw duplicate status", r.status);
      show("raw duplicate body", r.body);
      const tag = process.argv[5] ?? "dup";
      save(`payout-duplicate-${tag}`, r.status, r.body);
      const g = await restPayoutGateway.create({ senderBatchId: arg, receiver: VET, amount: 1000, note: "spike" });
      console.log("gateway.create classification ->", JSON.stringify(g));
      if (batchId) {
        const raw = await api("GET", `/v1/payments/payouts/${batchId}`);
        const it = raw.body?.items;
        console.log("after duplicate: batch_status", raw.body?.batch_header?.batch_status, "items:", it?.length,
          "statuses:", JSON.stringify(it?.map((x: any) => x.transaction_status)));
      }
      return;
    }
    case "invalid": {
      const a = await rawPayout(`spike-bad-${Date.now()}`, "not-an-email", "10.00");
      console.log("invalid receiver status", a.status); show("body", a.body); save("payout-invalid-receiver", a.status, a.body);
      const b = await rawPayout(`spike-nouser-${Date.now()}`, "no-such-user@example.invalid", "10.00");
      console.log("unregistered receiver status", b.status); show("body", b.body); save("payout-unregistered-receiver", b.status, b.body);
      if (b.status < 300) console.log("unregistered batch id:", b.body?.batch_header?.payout_batch_id);
      const g = await restPayoutGateway.create({ senderBatchId: `spike-gbad-${Date.now()}`, receiver: "not-an-email", amount: 1000, note: "spike" });
      console.log("gateway classification for invalid receiver ->", JSON.stringify(g));
      return;
    }
    case "toolkit": {
      const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/bedrock");
      const tk = new PayPalAgentToolkit({
        clientId: ID,
        clientSecret: SECRET,
        configuration: {
          actions: { orders: { get: true }, transactions: { list: true } },
          context: { sandbox: true },
        },
      });
      const tools = tk.getTools();
      console.log("tool count:", tools.length);
      console.log("tool names:", JSON.stringify(tools.map((t) => t.toolSpec.name)));
      if (arg) {
        const names = tools.map((t) => t.toolSpec.name);
        const name = names.find((n: string) => /get_order/.test(n)) ?? "get_order";
        const out = await tk.handleToolCall({ toolUseId: "spike", name, input: { id: arg } });
        const text = JSON.stringify(out);
        console.log("handleToolCall(", name, ") ->", text.replace(/[\w.+-]+@[\w.-]+/g, "<email>").slice(0, 1500));
        let inner: unknown = out;
        try { inner = JSON.parse(JSON.parse(out.content[0]?.text ?? "null")); } catch { /* keep raw */ }
        save("toolkit-get-order", 200, inner);
      }
      return;
    }
    default:
      console.error("usage: order | capture <id> | payout | payout-status <batchId> | duplicate <senderBatchId> [batchId] [tag] | invalid | toolkit [orderId]");
      process.exit(1);
  }
}
main().catch((e) => { console.error("spike failed:", e instanceof Error ? e.name + ": " + e.message.replace(/[\w.+-]+@[\w.-]+/g, "<email>") : "error"); process.exit(1); });
