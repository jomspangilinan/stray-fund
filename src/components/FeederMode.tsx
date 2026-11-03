"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LiveCamera, locate, toJpeg } from "./LiveCamera";
import { SignIn } from "./SignIn";
import { COOLDOWN_MS, frameDiff, shouldCapture } from "@/lib/motion";

const SAMPLE_EVERY_MS = 500;
const SAMPLE_WIDTH = 160;

type State = "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";
type Last = { text: string; catId: string | null; at: number };

const TEXT: Record<State, string> = {
  new_cat: "A new card was made.",
  matched: "Seen before.",
  needs_review: "Sent for a quick check.",
  rejected: "",
  queued_for_ai: "Saved, the photo will be looked at shortly.",
};

type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockApi = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

export function FeederMode({ username }: { username: string | null }) {
  if (!username) {
    return (
      <div className="mt-8">
        <p className="mb-4">Sign in so the photos are linked to you.</p>
        <SignIn username={null} inline />
      </div>
    );
  }
  return <Watching />;
}

function Watching() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const prevRef = useRef<ImageData | null>(null);
  const lastCaptureAt = useRef<number | null>(null);
  const inFlight = useRef(false);
  const wake = useRef<WakeLockSentinelLike | null>(null);
  const alive = useRef(true);
  const [watching, setWatching] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for the camera.");
  const [last, setLast] = useState<Last | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [sent, setSent] = useState(0);

  const onVideoReady = useCallback((v: HTMLVideoElement | null) => {
    videoRef.current = v;
    prevRef.current = null;
    setWatching(v !== null);
    setStatus(v ? "Watching for movement." : "Waiting for the camera.");
  }, []);

  const capture = useCallback(async (video: HTMLVideoElement) => {
    inFlight.current = true;
    lastCaptureAt.current = Date.now();
    setStatus("Movement seen. Sending a photo.");
    try {
      const blob = await toJpeg(video);
      if (!blob) {
        setStatus("Could not read a frame. Still watching.");
        return;
      }
      const where = await locate();
      const form = new FormData();
      form.set("photo", new File([blob], "cat.jpg", { type: "image/jpeg" }));
      if (where.lat !== null && where.lng !== null) {
        form.set("lat", String(where.lat));
        form.set("lng", String(where.lng));
      }
      const res = await fetch("/api/catch", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { state?: State; catId?: string | null; error?: string };
      if (!alive.current) return;
      if (res.status === 429) {
        setStatus("Sending too fast. Pausing, still watching.");
      } else if (res.status === 401 || res.status === 403) {
        setStatus("Signed out. Sign in again to keep sending photos.");
      } else if (!res.ok || !body.state) {
        setStatus("The last photo did not go through. Still watching.");
      } else if (body.state === "rejected") {
        setSkipped((n) => n + 1);
        setStatus("Watching for movement.");
      } else {
        setSent((n) => n + 1);
        setLast({ text: TEXT[body.state], catId: body.catId ?? null, at: Date.now() });
        setStatus(body.state === "queued_for_ai" ? "Saved for later. Still watching." : "Watching for movement.");
      }
    } catch {
      if (alive.current) setStatus("No connection. Still watching.");
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Motion loop: a small downscaled sample every 500 ms, paused while the tab is hidden.
  useEffect(() => {
    if (!watching) return;
    const canvas = document.createElement("canvas");
    const tick = () => {
      const v = videoRef.current;
      if (document.hidden || !v || !v.videoWidth || !v.videoHeight) return;
      try {
        canvas.width = SAMPLE_WIDTH;
        canvas.height = Math.max(1, Math.round((SAMPLE_WIDTH * v.videoHeight) / v.videoWidth));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const cur = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const prev = prevRef.current;
        prevRef.current = cur;
        if (!prev || prev.width !== cur.width || prev.height !== cur.height) return;
        const diff = frameDiff(prev, cur);
        if (shouldCapture({ diff, lastCaptureAt: lastCaptureAt.current, now: Date.now(), inFlight: inFlight.current })) {
          void capture(v);
        }
      } catch {
        // A bad frame never stops the loop.
      }
    };
    const timer = setInterval(tick, SAMPLE_EVERY_MS);
    const onVisible = () => {
      // Drop the stale frame so waking up is not read as movement.
      prevRef.current = null;
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [watching, capture]);

  // Keep the screen on, re-acquire when the tab comes back, release on unmount.
  useEffect(() => {
    alive.current = true;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    const acquire = async () => {
      if (!api) return setHint("Keep the screen on yourself so the camera keeps watching.");
      if (document.hidden || wake.current) return;
      try {
        const lock = await api.request("screen");
        if (!alive.current) return void lock.release().catch(() => {});
        wake.current = lock;
        setHint(null);
      } catch {
        setHint("Keep the screen on yourself so the camera keeps watching.");
      }
    };
    void acquire();
    const onVis = () => {
      if (document.hidden) wake.current = null; // the browser drops the lock when hidden
      else void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVis);
      const lock = wake.current;
      wake.current = null;
      void lock?.release().catch(() => {});
    };
  }, []);

  return (
    <div className="mt-6 grid gap-4">
      <LiveCamera onCapture={() => {}} onVideoReady={onVideoReady} hideShutter />
      <p role="status" className="font-bold">
        {status}
      </p>
      <p className="text-dusk">
        {sent} sent, {skipped} skipped. One photo at most every {COOLDOWN_MS / 1000} seconds.
      </p>
      {hint && <p className="note">{hint}</p>}
      {last && (
        <div className="note note-ok">
          <p>{last.text}</p>
          {last.catId && (
            <Link href={`/cats/${last.catId}`} className="btn-quiet mt-2 inline-flex items-center">
              See the card
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
