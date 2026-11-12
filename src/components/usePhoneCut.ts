"use client";

import { useCallback, useEffect, useRef } from "react";
import { LOAD_LIMIT_MS } from "@/lib/catDetect";
import { MASK_SIDE, PHONE_CUT_TIMEOUT_MS, phoneCutAllowed } from "@/lib/catMask";
import type { CatBox } from "@/lib/keepsake";
import { cutCat, orNullAfter, type SegRun } from "@/lib/phoneCut";

const MODEL_URL = "/models/cat-seg-v1/yolo11n-seg.onnx";
/** onnxruntime-web's runtime files, copied here by scripts/copy-ort.mjs, so nothing loads from a CDN. */
const ORT_PATH = "/ort/";
/** The live view is timed this long once the model is in. */
const FPS_WINDOW_MS = 600;
/** The photo is shrunk to this many pixels on its longer side first. The model sees 640 anyway. */
const WORK_SIDE = 640;

export type PhoneCut = { mask: Uint8Array; box: CatBox };

/** Frames a second the page manages to draw over a short window. */
function measureFps(): Promise<number> {
  return new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      frames++;
      if (now - t0 >= FPS_WINDOW_MS) resolve((frames * 1000) / (now - t0));
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function loadRunner(): Promise<SegRun> {
  // A dynamic import, so the runtime is fetched only on the Spot camera and only when the phone tier is wanted.
  const ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = ORT_PATH;
  // Threads need a cross-origin isolated page, which this site is not.
  ort.env.wasm.numThreads = 1;
  const bytes = new Uint8Array(await (await fetch(MODEL_URL)).arrayBuffer());
  const hasGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const providers: ("webgpu" | "wasm")[][] = hasGpu ? [["webgpu"], ["wasm"]] : [["wasm"]];
  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>> | null = null;
  for (const executionProviders of providers) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders });
      break;
    } catch {
      // WebGPU may exist but fail to start. Try the next backend.
    }
  }
  if (!session) throw new Error("no backend");
  const s = session;
  return async (input) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 640, 640]) });
    return { out0: out.output0.data as Float32Array, out1: out.output1.data as Float32Array };
  };
}

/** The photo as a canvas no bigger than WORK_SIDE, ready for `cut`. */
export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, WORK_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas;
  } catch {
    return null;
  }
}

/** A cut-out as a 64x64 PNG, the form /api/spot takes. */
export function maskToPng(mask: Uint8Array): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = MASK_SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  const img = ctx.createImageData(MASK_SIDE, MASK_SIDE);
  for (let i = 0; i < mask.length; i++) img.data.set([mask[i], mask[i], mask[i], 255], i * 4);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * The phone tier. Once the camera is open and `enabled`, loads the cat model, and only if the connection, the load time
 * and the frame rate allow it. `cut` then runs it on the upright photo. Any doubt, failure or the PHONE_CUT_TIMEOUT_MS
 * limit gives null, so the photo goes up alone and the server develops it. It never blocks the shutter.
 */
export function usePhoneCut(enabled: boolean): { cut(canvas: HTMLCanvasElement): Promise<PhoneCut | null>; ready(): boolean } {
  const runner = useRef<SegRun | null>(null);
  const busy = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection ?? null;
    if (!phoneCutAllowed({ connection, loadedWithinLimit: true, fps: Infinity })) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<SegRun | null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOAD_LIMIT_MS);
      loadRunner().then(resolve, () => resolve(null));
    });
    loaded
      .then(async (run) => {
        clearTimeout(timer);
        const fps = run ? await measureFps() : 0;
        if (run && phoneCutAllowed({ connection, loadedWithinLimit: true, fps })) runner.current = run;
      })
      .catch(() => undefined);
  }, [enabled]);

  const cut = useCallback(async (canvas: HTMLCanvasElement): Promise<PhoneCut | null> => {
    const run = runner.current;
    if (!run || busy.current) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    busy.current = true;
    const work = cutCat(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, run);
    // A run that outlasts the limit is left to finish, and no second one starts until it has.
    const free = () => {
      busy.current = false;
    };
    work.then(free, free);
    return orNullAfter(work, PHONE_CUT_TIMEOUT_MS);
  }, []);

  /** True when `cut` would really run the model now. The screen says it is finding the cat only then. */
  const ready = useCallback(() => runner.current !== null && !busy.current, []);

  return { cut, ready };
}
