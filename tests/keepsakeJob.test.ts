import { describe, expect, it, vi } from "vitest";
import { createJob, handOver } from "../src/lib/keepsakeJob";

const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createJob", () => {
  it("builds once, however many times it is started, and ends ready", async () => {
    const build = vi.fn(async () => file);
    const job = createJob(build, 1000);
    expect(job.state()).toBe("idle");
    job.start();
    job.start();
    expect(job.state()).toBe("building");
    await tick();
    expect(build).toHaveBeenCalledTimes(1);
    expect(job.state()).toBe("ready");
    expect(job.file()).toBe(file);
  });

  it("expires a stalled build, aborts it, and a retry builds again", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let stall = true;
      const build = vi.fn((s: AbortSignal) => {
        signals.push(s);
        return stall ? new Promise<File>(() => {}) : Promise.resolve(file);
      });
      const job = createJob(build, 20_000);
      job.start();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(job.state()).toBe("building");
      await vi.advanceTimersByTimeAsync(2);
      expect(job.state()).toBe("failed");
      expect(signals[0].aborted).toBe(true);
      stall = false;
      job.retry();
      expect(job.state()).toBe("building");
      await vi.advanceTimersByTimeAsync(0);
      expect(job.state()).toBe("ready");
      expect(build).toHaveBeenCalledTimes(2);
      expect(signals[1].aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails on an error, and a late result from an expired build is ignored", async () => {
    vi.useFakeTimers();
    try {
      let late!: (f: File) => void;
      const job = createJob(() => new Promise<File>((r) => (late = r)), 1000);
      job.start();
      await vi.advanceTimersByTimeAsync(1001);
      expect(job.state()).toBe("failed");
      late(file);
      await vi.advanceTimersByTimeAsync(0);
      expect(job.state()).toBe("failed");
      expect(job.file()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    const bad = createJob(async () => { throw new Error("x"); }, 1000);
    bad.start();
    await tick();
    expect(bad.state()).toBe("failed");
  });

  it("tells listeners about each change", async () => {
    const job = createJob(async () => file, 1000);
    const seen: string[] = [];
    job.subscribe(() => seen.push(job.state()));
    job.start();
    await tick();
    expect(seen).toEqual(["building", "ready"]);
  });
});

describe("handOver", () => {
  it("calls share synchronously, before any await, when the file can be shared", () => {
    const share = vi.fn(async () => {});
    const download = vi.fn();
    const p = handOver(file, { canShare: () => true, share }, download);
    // No await has happened yet: the tap's permission is still live.
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ files: [file] });
    expect(download).not.toHaveBeenCalled();
    return expect(p).resolves.toBe("done");
  });

  it("treats a dismissed share sheet as done, and a lost permission as again", async () => {
    const dismissed = new DOMException("x", "AbortError");
    const denied = new DOMException("x", "NotAllowedError");
    expect(await handOver(file, { canShare: () => true, share: async () => { throw dismissed; } }, vi.fn())).toBe("done");
    expect(await handOver(file, { canShare: () => true, share: async () => { throw denied; } }, vi.fn())).toBe("again");
  });

  it("downloads when sharing files is not possible, and after any other share error", async () => {
    const download = vi.fn();
    expect(await handOver(file, { canShare: () => false, share: vi.fn() }, download)).toBe("done");
    expect(await handOver(file, undefined, download)).toBe("done");
    expect(await handOver(file, { canShare: () => true, share: async () => { throw new Error("boom"); } }, download)).toBe("done");
    expect(download).toHaveBeenCalledTimes(3);
  });
});
