import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPayPalTokenCache,
  restPayoutGateway,
} from "../src/server/paypal/payouts";

const INPUT = {
  senderBatchId: "payout-row-id",
  receiver: "vet@example.test",
  amount: 150050,
  note: "note text",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const TOKEN = () => json(200, { access_token: "tok-1", expires_in: 3600 });
const CREATED = () =>
  json(201, { batch_header: { payout_batch_id: "PB-1", batch_status: "PENDING" } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(api: Handler, token: Handler = TOKEN) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return url.endsWith("/v1/oauth2/token") ? token(url, init!) : api(url, init!);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const tokenCalls = (fn: ReturnType<typeof stubFetch>) =>
  fn.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"));
const apiCalls = (fn: ReturnType<typeof stubFetch>) =>
  fn.mock.calls.filter(([u]) => !String(u).endsWith("/v1/oauth2/token"));

describe("restPayoutGateway", () => {
  beforeEach(() => {
    clearPayPalTokenCache();
    vi.stubEnv("PAYPAL_CLIENT_ID", "id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    vi.stubEnv("PAYPAL_ENV", "sandbox");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("create", () => {
    it("sends the documented body, with centavos converted here", async () => {
      const fn = stubFetch(CREATED);
      const result = await restPayoutGateway.create(INPUT);
      expect(result).toEqual({ kind: "sent", batchId: "PB-1", status: "PENDING" });

      const [[url, init]] = apiCalls(fn);
      expect(String(url)).toBe("https://api-m.sandbox.paypal.com/v1/payments/payouts");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tok-1");
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body.sender_batch_header.sender_batch_id).toBe("payout-row-id");
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        recipient_type: "EMAIL",
        amount: { value: "1500.50", currency: "PHP" },
        receiver: "vet@example.test",
        note: "note text",
      });
    });

    it("sends PayPal-Request-Id equal to the sender batch id, the same on every send of one payout", async () => {
      const fn = stubFetch(CREATED);
      await restPayoutGateway.create(INPUT);
      await restPayoutGateway.create(INPUT);
      await restPayoutGateway.create({ ...INPUT, senderBatchId: "another-row" });
      const ids = apiCalls(fn).map(([, init]) => new Headers(init?.headers).get("paypal-request-id"));
      expect(ids).toEqual(["payout-row-id", "payout-row-id", "another-row"]);
    });

    it("asks for a token with basic auth", async () => {
      const fn = stubFetch(CREATED);
      await restPayoutGateway.create(INPUT);
      const [[url, init]] = tokenCalls(fn);
      expect(String(url)).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        `Basic ${Buffer.from("id:secret").toString("base64")}`,
      );
      expect(String(init?.body)).toBe("grant_type=client_credentials");
    });

    it.each([
      [200, "sent"],
      [201, "sent"],
      [400, "rejected"],
      [403, "rejected"],
      [404, "rejected"],
      [422, "rejected"],
      [408, "unknown"],
      [409, "unknown"],
      [429, "unknown"],
      [500, "unknown"],
      [503, "unknown"],
    ])("classifies HTTP %i as %s", async (status, kind) => {
      stubFetch(() =>
        status < 300
          ? json(status, { batch_header: { payout_batch_id: "PB-1", batch_status: "PENDING" } })
          : json(status, { name: "SOME_ERROR", message: "secret detail vet@example.test" }),
      );
      const result = await restPayoutGateway.create(INPUT);
      expect(result.kind).toBe(kind);
      if (result.kind !== "sent") {
        expect(result.error).toContain(String(status));
        expect(result.error).not.toContain("@");
      }
    });

    it("surfaces only the PayPal error name from a rejection", async () => {
      stubFetch(() => json(422, { name: "VALIDATION_ERROR", message: "bad vet@example.test" }));
      expect(await restPayoutGateway.create(INPUT)).toEqual({
        kind: "rejected",
        error: "HTTP 422 VALIDATION_ERROR",
      });
    });

    describe("duplicate sender batch id", () => {
      // The scrubbed body PayPal's sandbox returned, immediately and after SUCCESS.
      const duplicateBody = (details?: unknown) => ({
        name: "USER_BUSINESS_ERROR",
        message: "User business error.",
        debug_id: "DEBUG_FAKE",
        information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
        details: details ?? [
          {
            field: "SENDER_BATCH_ID",
            location: "body",
            issue: "Batch with given sender_batch_id already exists",
            link: [
              {
                href: "https://api.sandbox.paypal.com/v1/payments/payouts/FAKE",
                rel: "self",
                method: "GET",
                encType: "application/json",
              },
            ],
          },
        ],
        links: [],
      });

      it("parses the real body, taking the batch id from the self link", async () => {
        stubFetch(() => json(400, duplicateBody()));
        expect(await restPayoutGateway.create(INPUT)).toEqual({
          kind: "duplicate",
          batchId: "FAKE",
          error: "HTTP 400 USER_BUSINESS_ERROR SENDER_BATCH_ID",
        });
      });

      it.each(["payout-duplicate-immediate.json", "payout-duplicate-final.json"])(
        "parses the recorded response in %s",
        async (file) => {
          const recorded = JSON.parse(
            readFileSync(new URL(`./fixtures/paypal/${file}`, import.meta.url), "utf8"),
          ) as { status: number; body: unknown };
          stubFetch(() => json(recorded.status, recorded.body));
          expect(await restPayoutGateway.create(INPUT)).toEqual({
            kind: "duplicate",
            batchId: "FAKE",
            error: "HTTP 400 USER_BUSINESS_ERROR SENDER_BATCH_ID",
          });
        },
      );

      it.each([
        ["no link", [{ field: "SENDER_BATCH_ID", issue: "exists" }]],
        ["an empty link list", [{ field: "SENDER_BATCH_ID", link: [] }]],
        ["a non-self link", [{ field: "SENDER_BATCH_ID", link: [{ rel: "next", href: "https://x/v1/payments/payouts/NOPE" }] }]],
        ["a self link elsewhere", [{ field: "SENDER_BATCH_ID", link: [{ rel: "self", href: "https://x/v1/payments/payouts-item/NOPE" }] }]],
        ["a non-string href", [{ field: "SENDER_BATCH_ID", link: [{ rel: "self", href: 7 }] }]],
      ])("is a duplicate with no batch id given %s", async (_name, details) => {
        stubFetch(() => json(400, duplicateBody(details)));
        const result = await restPayoutGateway.create(INPUT);
        expect(result.kind).toBe("duplicate");
        expect(result).not.toHaveProperty("batchId");
      });

      it.each([
        ["the same error name on another field", [{ field: "items[0].receiver", issue: "Batch with given sender_batch_id already exists" }]],
        ["the same error name with no details", []],
        ["details that are not a list", "SENDER_BATCH_ID"],
        ["a null entry", [null]],
      ])("is rejected given %s", async (_name, details) => {
        stubFetch(() => json(400, duplicateBody(details)));
        expect(await restPayoutGateway.create(INPUT)).toEqual({
          kind: "rejected",
          error: "HTTP 400 USER_BUSINESS_ERROR",
        });
      });

      it("keeps details and messages out of the error", async () => {
        stubFetch(() => json(400, { ...duplicateBody(), message: "vet@example.test" }));
        const result = await restPayoutGateway.create(INPUT);
        expect(result.kind === "duplicate" && result.error).not.toContain("@");
      });
    });

    it("a rejection with an unreadable body is still rejected", async () => {
      stubFetch(() => new Response("<html>", { status: 400 }));
      expect((await restPayoutGateway.create(INPUT)).kind).toBe("rejected");
    });

    it("a network error is unknown", async () => {
      stubFetch(() => {
        throw new TypeError("fetch failed");
      });
      expect((await restPayoutGateway.create(INPUT)).kind).toBe("unknown");
    });

    it("a 2xx with no batch id is unknown, since there is nothing to track", async () => {
      stubFetch(() => json(201, {}));
      expect((await restPayoutGateway.create(INPUT)).kind).toBe("unknown");
      stubFetch(() => new Response("not json", { status: 201 }));
      expect((await restPayoutGateway.create(INPUT)).kind).toBe("unknown");
    });

    it("aborts after 30 seconds and reports unknown", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      let settled = false;
      const pending = restPayoutGateway.create(INPUT).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).kind).toBe("unknown");
    });

    it.each([
      ["a token network error", () => { throw new TypeError("fetch failed"); }],
      ["a token 5xx", () => json(503, {})],
      ["a token 401", () => json(401, { error: "invalid_client" })],
    ] as [string, Handler][])(
      "%s is unknown and sends nothing",
      async (_name, token) => {
        const fn = stubFetch(CREATED, token);
        expect((await restPayoutGateway.create(INPUT)).kind).toBe("unknown");
        expect(apiCalls(fn)).toEqual([]);
      },
    );

    it("missing credentials are unknown and send nothing", async () => {
      vi.stubEnv("PAYPAL_CLIENT_ID", "");
      const fn = stubFetch(CREATED);
      const result = await restPayoutGateway.create(INPUT);
      expect(result.kind).toBe("unknown");
      expect(fn).not.toHaveBeenCalled();
    });

    it("never leaks the secret or token in an error", async () => {
      stubFetch(() => {
        throw new Error("boom tok-1 secret");
      });
      const result = await restPayoutGateway.create(INPUT);
      expect(JSON.stringify(result)).not.toMatch(/tok-1|secret/);
    });
  });

  describe("token cache", () => {
    it("reuses the token between calls", async () => {
      const fn = stubFetch(CREATED);
      await restPayoutGateway.create(INPUT);
      await restPayoutGateway.create(INPUT);
      expect(tokenCalls(fn)).toHaveLength(1);
      expect(apiCalls(fn)).toHaveLength(2);
    });

    it("fetches a new token once the old one nears expiry", async () => {
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1_000_000);
      const fn = stubFetch(CREATED);
      await restPayoutGateway.create(INPUT);
      now.mockReturnValue(1_000_000 + 3_500_000);
      await restPayoutGateway.create(INPUT);
      expect(tokenCalls(fn)).toHaveLength(1);
      now.mockReturnValue(1_000_000 + 3_541_000);
      await restPayoutGateway.create(INPUT);
      expect(tokenCalls(fn)).toHaveLength(2);
      now.mockRestore();
    });

    it("drops the cached token on a 401", async () => {
      const fn = stubFetch(() => json(401, { name: "AUTHENTICATION_FAILURE" }));
      expect((await restPayoutGateway.create(INPUT)).kind).toBe("rejected");
      await restPayoutGateway.create(INPUT);
      expect(tokenCalls(fn)).toHaveLength(2);
    });

    it("does not reuse a token across credential changes", async () => {
      const fn = stubFetch(CREATED);
      await restPayoutGateway.create(INPUT);
      vi.stubEnv("PAYPAL_CLIENT_ID", "other");
      await restPayoutGateway.create(INPUT);
      expect(tokenCalls(fn)).toHaveLength(2);
    });
  });

  describe("environment", () => {
    it("uses production only when PAYPAL_ENV is production, read at call time", async () => {
      const fn = stubFetch(CREATED);
      vi.stubEnv("PAYPAL_ENV", "production");
      await restPayoutGateway.create(INPUT);
      expect(String(apiCalls(fn)[0][0])).toBe("https://api-m.paypal.com/v1/payments/payouts");
    });

    it.each(["", "live", "PRODUCTION"])("treats PAYPAL_ENV=%j as sandbox", async (value) => {
      const fn = stubFetch(CREATED);
      vi.stubEnv("PAYPAL_ENV", value);
      await restPayoutGateway.create(INPUT);
      expect(String(apiCalls(fn)[0][0])).toContain("api-m.sandbox.paypal.com");
    });
  });

  describe("get", () => {
    it("maps the batch, item and fee, converting the fee to centavos", async () => {
      const fn = stubFetch(() =>
        json(200, {
          batch_header: { batch_status: "SUCCESS" },
          items: [
            {
              payout_item_id: "I-1",
              transaction_status: "SUCCESS",
              payout_item_fee: { currency: "PHP", value: "25.50" },
            },
          ],
        }),
      );
      expect(await restPayoutGateway.get("PB/1")).toEqual({
        batchStatus: "SUCCESS",
        itemId: "I-1",
        itemStatus: "SUCCESS",
        fee: 2550,
      });
      expect(String(apiCalls(fn)[0][0])).toBe(
        "https://api-m.sandbox.paypal.com/v1/payments/payouts/PB%2F1",
      );
    });

    it("omits an unreadable fee and still returns the status", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      stubFetch(() =>
        json(200, {
          batch_header: { batch_status: "SUCCESS" },
          items: [{ transaction_status: "SUCCESS", payout_item_fee: { value: "1.234" } }],
        }),
      );
      expect(await restPayoutGateway.get("PB-1")).toEqual({
        batchStatus: "SUCCESS",
        itemStatus: "SUCCESS",
      });
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it("handles a batch with no items yet", async () => {
      stubFetch(() => json(200, { batch_header: { batch_status: "PENDING" } }));
      expect(await restPayoutGateway.get("PB-1")).toEqual({ batchStatus: "PENDING" });
    });

    it("throws on a failed read, so the caller polls again later", async () => {
      stubFetch(() => json(500, {}));
      await expect(restPayoutGateway.get("PB-1")).rejects.toThrow(/500/);
      stubFetch(() => json(404, {}));
      await expect(restPayoutGateway.get("PB-1")).rejects.toThrow(/404/);
    });

    it("throws when a success body has no batch status", async () => {
      stubFetch(() => json(200, {}));
      await expect(restPayoutGateway.get("PB-1")).rejects.toThrow();
    });
  });
});
