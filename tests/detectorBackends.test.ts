import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as tf from "@tensorflow/tfjs-core";

// coco-ssd switches to the cpu backend during detect, so the detector module must register both backends.
// The webgl backend only registers in a browser, so a window is faked. findBackend would try to build the
// webgl backend, which cannot exist in node, so this checks the registered factories.
describe("detector module", () => {
  beforeAll(() => {
    vi.stubGlobal("window", { document: {} });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  it("registers the webgl and cpu backends", async () => {
    await import("../src/lib/detector");
    expect(tf.findBackendFactory("webgl")).toBeTruthy();
    expect(tf.findBackendFactory("cpu")).toBeTruthy();
  });
});
