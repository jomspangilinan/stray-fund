/*
 * The on-device cat detector, loaded only by the spot camera through a dynamic import. The model files are
 * served from /models/cat-detector-v1 on this site, so nothing is requested from anywhere else, and no photo or
 * frame leaves the device for this step. Packages are pinned in package.json.
 */
import "@tensorflow/tfjs-backend-webgl";
// coco-ssd switches to the cpu backend while it post-processes boxes, so cpu must be registered too.
import "@tensorflow/tfjs-backend-cpu";
import * as tf from "@tensorflow/tfjs-core";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import type { Prediction } from "./catDetect";

export type Detector = { detect(video: HTMLVideoElement): Promise<Prediction[]>; dispose(): void };

export async function loadDetector(): Promise<Detector> {
  await tf.setBackend("webgl");
  await tf.ready();
  const model = await cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: "/models/cat-detector-v1/model.json" });
  return {
    async detect(video) {
      const out = await model.detect(video, 3, MIN_REPORT);
      return out.map((o) => ({ class: o.class, score: o.score, bbox: o.bbox as [number, number, number, number] }));
    },
    dispose() {
      model.dispose();
    },
  };
}

const MIN_REPORT = 0.3;
