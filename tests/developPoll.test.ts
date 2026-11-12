import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEUTRAL_AVATAR } from "../src/lib/avatar";
import { developLines, pollDeveloped, type DevelopStatus } from "../src/lib/developPoll";
import { DEVELOP_POLL_LIMIT_MS, DEVELOP_POLL_MS, DEVELOP_SOON_MS } from "../src/lib/scanSteps";
import { CaptureCard } from "../src/components/CaptureAnimation";

const waiting: DevelopStatus = { developed: false, photoUrl: null, avatar: NEUTRAL_AVATAR };
const ready: DevelopStatus = { developed: true, photoUrl: "https://example.test/p.jpg", avatar: NEUTRAL_AVATAR };

describe("pollDeveloped", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks every DEVELOP_POLL_MS and stops when developed", async () => {
    const fetchStatus = vi.fn<() => Promise<DevelopStatus>>().mockResolvedValueOnce(waiting).mockResolvedValueOnce(waiting).mockResolvedValue(ready);
    const out = pollDeveloped(fetchStatus, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEVELOP_POLL_MS - 1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEVELOP_POLL_MS);
    expect(await out).toEqual({ kind: "developed", status: ready });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("says soon at 45 s, keeps polling, and still catches a photo at 119 s", async () => {
    const fetchStatus = vi.fn(async () => (Date.now() - t0 >= 119_000 ? ready : waiting));
    const t0 = Date.now();
    const onSoon = vi.fn();
    const out = pollDeveloped(fetchStatus, { onSoon });
    await vi.advanceTimersByTimeAsync(DEVELOP_SOON_MS - DEVELOP_POLL_MS);
    expect(onSoon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEVELOP_POLL_MS);
    expect(onSoon).toHaveBeenCalledTimes(1);
    const before = fetchStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus.mock.calls.length).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await out).toEqual({ kind: "developed", status: ready });
    expect(onSoon).toHaveBeenCalledTimes(1);
  });

  it("gives up at DEVELOP_POLL_LIMIT_MS and no later", async () => {
    const fetchStatus = vi.fn(async () => waiting);
    const out = pollDeveloped(fetchStatus, {});
    let settled = false;
    void out.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(DEVELOP_POLL_LIMIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(DEVELOP_POLL_MS);
    expect(await out).toEqual({ kind: "timeout" });
    const n = fetchStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus.mock.calls.length).toBe(n);
  });

  it("treats a failed request as not yet and tries again", async () => {
    const fetchStatus = vi.fn<() => Promise<DevelopStatus | null>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(null).mockResolvedValue(ready);
    const out = pollDeveloped(fetchStatus, {});
    await vi.advanceTimersByTimeAsync(DEVELOP_POLL_MS * 3);
    expect(await out).toEqual({ kind: "developed", status: ready });
  });

  it("stops at once when the server says the photo is not ours", async () => {
    const fetchStatus = vi.fn(async () => "stop" as const);
    expect(await pollDeveloped(fetchStatus, {})).toEqual({ kind: "stopped" });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("stops when aborted, even mid-wait", async () => {
    const ac = new AbortController();
    const fetchStatus = vi.fn(async () => waiting);
    const out = pollDeveloped(fetchStatus, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await out).toEqual({ kind: "stopped" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});

describe("developLines", () => {
  it("says Developing while it waits, and claims nothing more", () => {
    expect(developLines({ developed: false, soon: false })).toEqual({ card: "Developing…", yard: "Your cat is in the yard." });
  });
  it("tells the person the photo is late after the soon point", () => {
    expect(developLines({ developed: false, soon: true })).toEqual({
      card: null,
      yard: "Your cat is in the yard. The photo will appear soon.",
    });
  });
  it("drops the waiting line once developed", () => {
    expect(developLines({ developed: true, soon: true })).toEqual({ card: null, yard: "Your cat is in the yard." });
  });
});

describe("the capture card", () => {
  const html = (label: string | null) => renderToStaticMarkup(createElement(CaptureCard, { photoUrl: "blob:x", label }));
  it("shows the label it is given, and none when there is none", () => {
    expect(html("Finding your cat…")).toContain("Finding your cat…");
    expect(html(null)).not.toContain("cap-label");
  });
  it("never mentions AI or a check", () => {
    expect(html("Developing…")).not.toMatch(/\bAI\b|check/i);
  });
});
