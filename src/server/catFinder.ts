import path from "node:path";
import sharp from "sharp";
import type { InferenceSession } from "onnxruntime-node";
import type { CatBox } from "@/lib/keepsake";
import { MASK_SIDE } from "@/lib/catMask";
import { decodeCat, INPUT_SIDE, letterbox } from "@/lib/yoloSeg";

/*
 * The worker's cat finder: YOLO11n-seg on onnxruntime-node, CPU only, one thread. Worker process only:
 * develop.ts is the one importer, and the runtime is loaded on the first photo, so nothing loads the native
 * binary until a photo needs it. A run holds the event loop while it lasts (about 0.3 s on an
 * M2), so an abort takes effect when the run ends, not part way through it.
 */

export const MODEL_FILE = path.join(process.cwd(), "public", "models", "cat-seg-v1", "yolo11n-seg.onnx");

export type Found = { box: CatBox | null; mask: Buffer | null };

let session: Promise<InferenceSession> | null = null;
/** One inference at a time. A run the timeout gave up on still holds the model until it finishes. */
let busy: Promise<unknown> = Promise.resolve();
let override: typeof findCat | null = null;

/** Replaces the model in tests. Null restores it. */
export function setCatFinderForTests(f: typeof findCat | null): void {
  override = f;
}

function loadSession(): Promise<InferenceSession> {
  session ??= import("onnxruntime-node")
    .then((ort) =>
      ort.InferenceSession.create(MODEL_FILE, {
        executionProviders: ["cpu"],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionMode: "sequential",
        graphOptimizationLevel: "all",
        // Without the arena the peak was about 20 MB lower in the Task 2D gate, at the same speed.
        enableCpuMemArena: false,
      }),
    )
    .catch((e) => {
      // A failed load is tried again on the next photo.
      session = null;
      throw e;
    });
  return session;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

async function infer(input: Float32Array): Promise<{ out0: Float32Array; out1: Float32Array }> {
  const s = await loadSession();
  const { Tensor } = await import("onnxruntime-node");
  const out = await s.run({ images: new Tensor("float32", input, [1, 3, INPUT_SIDE, INPUT_SIDE]) });
  return { out0: out.output0.data as Float32Array, out1: out.output1.data as Float32Array };
}

/**
 * Where the cat is in a photo and its cut-out (a 64x64 grey PNG over the whole frame), or nulls when the model
 * sees no cat. Rejects with the signal's reason once it aborts. The photo is shrunk to fit the model's input
 * first: the box and the cut-out are fractions of the frame, so they hold for the full-size photo.
 */
export async function findCat(jpeg: Buffer, signal: AbortSignal): Promise<Found> {
  if (override) return override(jpeg, signal);
  signal.throwIfAborted();
  const { data, info } = await sharp(jpeg)
    .removeAlpha()
    .ensureAlpha()
    .resize({ width: INPUT_SIDE, height: INPUT_SIDE, fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const lb = letterbox(data, info.width, info.height);
  const run = busy.then(() => infer(lb.input));
  busy = run.catch(() => undefined);
  const { out0, out1 } = await untilAborted(run, signal);
  const found = decodeCat(out0, out1, lb, info.width, info.height);
  if (!found) return { box: null, mask: null };
  const mask = await sharp(Buffer.from(found.mask), { raw: { width: MASK_SIDE, height: MASK_SIDE, channels: 1 } })
    .png()
    .toBuffer();
  return { box: found.box, mask };
}
