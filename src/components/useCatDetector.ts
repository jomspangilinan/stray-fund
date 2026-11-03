"use client";

import { useEffect, useState } from "react";
import { createLock, LOAD_LIMIT_MS, pickCat, tooSlow, type CatBox, type LockState } from "@/lib/catDetect";

export type DetectorView = { state: "off" | "looking" | "found"; box: CatBox | null; video: { w: number; h: number } | null };
const OFF: DetectorView = { state: "off", box: null, video: null };
/** Gap between checks, so the hint uses little battery. */
const PAUSE_MS = 110;
/** The first frames warm the GPU and are not counted as speed. */
const WARMUP_FRAMES = 3;

/**
 * Advisory only. Looks for a cat in the live video on the device. Any failure, a slow load or a slow
 * frame rate turns it off for good and the camera carries on as it was.
 */
export function useCatDetector(video: HTMLVideoElement | null, enabled: boolean): DetectorView {
  const [view, setView] = useState<DetectorView>(OFF);

  useEffect(() => {
    if (!video || !enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispose: (() => void) | undefined;

    const stop = () => {
      alive = false;
      if (timer) clearTimeout(timer);
      dispose?.();
      dispose = undefined;
    };
    const giveUp = () => {
      stop();
      setView(OFF);
    };

    const startedAt = performance.now();
    const loadTimer = setTimeout(giveUp, LOAD_LIMIT_MS);
    import("@/lib/detector")
      .then((m) => m.loadDetector())
      .then((det) => {
        clearTimeout(loadTimer);
        // A busy page can delay the timer above, so the elapsed time is checked here too.
        if (performance.now() - startedAt > LOAD_LIMIT_MS) {
          det.dispose();
          return giveUp();
        }
        if (!alive) return det.dispose();
        dispose = det.dispose;
        const lock = createLock();
        const frameMs: number[] = [];
        let seen = 0;
        setView({ state: "looking", box: null, video: null });
        const tick = async () => {
          if (!alive) return;
          if (document.hidden || video.readyState < 2 || !video.videoWidth) {
            timer = setTimeout(tick, 300);
            return;
          }
          const t0 = performance.now();
          try {
            const state: LockState = lock.update(pickCat(await det.detect(video)));
            if (!alive) return;
            setView({ state, box: lock.box, video: { w: video.videoWidth, h: video.videoHeight } });
          } catch {
            return giveUp();
          }
          const took = performance.now() - t0;
          if (++seen > WARMUP_FRAMES) frameMs.push(took);
          if (tooSlow(frameMs)) return giveUp();
          timer = setTimeout(tick, PAUSE_MS);
        };
        tick();
      })
      .catch(giveUp);

    return () => {
      clearTimeout(loadTimer);
      stop();
      setView(OFF);
    };
  }, [video, enabled]);

  return enabled && video ? view : OFF;
}
