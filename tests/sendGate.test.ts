import { describe, expect, it, vi } from "vitest";
import { SendGate } from "../src/lib/sendGate";

const slow = () => vi.fn(() => new Promise<void>((r) => setTimeout(r, 5)));

describe("the send gate", () => {
  it("with a confirm step, sends nothing until Send, then sends once", async () => {
    const post = slow();
    const gate = new SendGate<string>(true, post);
    await gate.submit("pay");
    expect(post).not.toHaveBeenCalled();
    expect(gate.asking).toBe("pay");
    await gate.submit("pay");
    expect(post).not.toHaveBeenCalled();
    await Promise.all([gate.confirm(), gate.confirm()]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("pay");
    expect(gate.asking).toBeNull();
  });

  it("Back drops the question and sends nothing", async () => {
    const post = slow();
    const gate = new SendGate<string>(true, post);
    await gate.submit("pay");
    gate.back();
    await gate.confirm();
    expect(post).not.toHaveBeenCalled();
  });

  it("two submits in one frame post once without a confirm step", async () => {
    const post = slow();
    const gate = new SendGate<string>(false, post);
    await Promise.all([gate.submit("a"), gate.submit("a")]);
    expect(post).toHaveBeenCalledTimes(1);
    await gate.submit("b");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("lets the person try again after a failed post", async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const gate = new SendGate<string>(false, post);
    await gate.submit("a").catch(() => {});
    await gate.submit("a");
    expect(post).toHaveBeenCalledTimes(2);
  });
});
