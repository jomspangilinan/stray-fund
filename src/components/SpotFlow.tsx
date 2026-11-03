"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { boxToView, clampBox } from "@/lib/catDetect";
import { toCatBox, type CatBox } from "@/lib/keepsake";
import { COLONY } from "@/lib/config";
import type { SpotReveal as Reveal } from "@/server/spotReveal";
import { LiveCamera, type CaptureLocation } from "./LiveCamera";
import { ScanChecklist } from "./ScanChecklist";
import { SignIn } from "./SignIn";
import { SpotReveal } from "./SpotReveal";
import { useCatDetector } from "./useCatDetector";

type Done = {
  state: "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";
  catId: string | null;
  message: string;
  reveal: Reveal | null;
  locationMissing: boolean;
};
type Phase =
  | { kind: "camera" }
  | { kind: "sending"; startedAt: number; responded: boolean; state?: Done["state"] }
  | { kind: "done"; done: Done }
  | { kind: "error"; message: string };

const HEADINGS: Record<Done["state"], string> = {
  new_cat: "A new card",
  matched: "Seen before",
  needs_review: "Thanks for spotting",
  rejected: "Try once more",
  queued_for_ai: "Saved",
};

/** How long every step shows ticked before the card appears. */
const TICKED_MS = 450;
/** A little room around the cat so the brackets frame it rather than touch it. */
function padded(b: { x: number; y: number; w: number; h: number }) {
  const px = b.w * 0.08;
  const py = b.h * 0.08;
  return { x: b.x - px, y: b.y - py, w: b.w + 2 * px, h: b.h + 2 * py };
}

const AREA = COLONY.area_name.split(",")[0];

export function SpotFlow({ username }: { username: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const urlRef = useRef<string | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const detector = useCatDetector(video, phase.kind === "camera" && Boolean(username));
  // The shutter reads the latest sighting of the cat, not the one from when the callback was made.
  const latest = useRef(detector);
  useEffect(() => {
    latest.current = detector;
  });
  const boxAtShutter = () => {
    const d = latest.current;
    return d.state === "found" && d.box && d.video ? toCatBox(d.box, d.video) : null;
  };
  const [stage, setStage] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const bracketBox =
    detector.state === "found" && detector.box && detector.video && typeof window !== "undefined"
      ? clampBox(boxToView(padded(detector.box), detector.video, { w: window.innerWidth, h: window.innerHeight }), {
          x: 16,
          y: (stage?.y ?? 0) + 12,
          w: window.innerWidth - 32,
          h: (stage?.h ?? window.innerHeight) - 12 - 52,
        })
      : null;

  const fullscreen = phase.kind !== "done" && Boolean(username);
  const covering = Boolean(username) && (phase.kind !== "done" || phase.done.reveal !== null);

  useEffect(() => {
    if (!covering) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [covering]);

  const startedAt = phase.kind === "sending" ? phase.startedAt : null;
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [startedAt]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  function keep(blob: Blob) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(blob);
    setCapturedUrl(urlRef.current);
  }

  function again() {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setCapturedUrl(null);
    setPhase({ kind: "camera" });
  }

  if (!username) {
    return (
      <div className="card mt-6">
        <p className="mb-4 font-bold">Sign in so we can link the photo to you.</p>
        <SignIn username={null} inline />
      </div>
    );
  }

  async function upload(blob: Blob, where: CaptureLocation, box: CatBox | null) {
    keep(blob);
    const startedAt = Date.now();
    setPhase({ kind: "sending", startedAt, responded: false });
    const form = new FormData();
    form.set("photo", new File([blob], "cat.jpg", { type: "image/jpeg" }));
    if (where.lat !== null && where.lng !== null) {
      form.set("lat", String(where.lat));
      form.set("lng", String(where.lng));
    }
    if (box) form.set("box", JSON.stringify(box));
    try {
      const res = await fetch("/api/spot", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as Partial<Done> & { error?: string };
      if (!res.ok || !body.state || !body.message) {
        setPhase({ kind: "error", message: body.error ?? "Could not send the photo. Try again." });
        return;
      }
      const done: Done = {
        state: body.state,
        catId: body.catId ?? null,
        message: body.message,
        reveal: body.reveal ?? null,
        locationMissing: where.lat === null,
      };
      // Tick every step first, so the list finishes only because the server answered.
      setPhase({ kind: "sending", startedAt, responded: true, state: done.state });
      await new Promise((r) => setTimeout(r, TICKED_MS));
      setPhase({ kind: "done", done });
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  if (phase.kind === "done") {
    const { done } = phase;
    if (done.reveal && (done.state === "new_cat" || done.state === "matched" || done.state === "needs_review")) {
      return (
        <SpotReveal
          state={done.state}
          catId={done.catId}
          reveal={done.reveal}
          capturedUrl={capturedUrl}
          locationMissing={done.locationMissing}
          onAgain={again}
        />
      );
    }
    return (
      <div className="mt-6 grid gap-5" role="status">
        <div className="note note-ok">
          <h2 className="h2">{HEADINGS[done.state]}</h2>
          <p className="mt-2">{done.message}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-quiet" onClick={again}>
            {done.state === "rejected" ? "Try again" : "Spot another"}
          </button>
        </div>
      </div>
    );
  }

  const sending = phase.kind === "sending";
  return (
    <>
      <p className="small soft mt-5 max-w-[52ch]">
        Live camera only, so old photos cannot be reused.
      </p>
      {fullscreen && (
        <LiveCamera
          fullscreen
          onVideoReady={setVideo}
          bracketBox={bracketBox}
          onStageRect={setStage}
          scanning={sending && Boolean(capturedUrl)}
          stageNote={
            !(sending && capturedUrl) && detector.state !== "off" ? (
              <p className="cam-status" role="status" aria-live="polite">
                {detector.state === "found" ? "Cat found" : "Looking for a cat"}
              </p>
            ) : null
          }
          onCapture={upload}
          boxAtShutter={boxAtShutter}
          disabled={sending}
          topBar={
            <>
              <Link href="/" className="cam-chip">
                Close
              </Link>
              <span className="cam-chip">{AREA}</span>
            </>
          }
          overlay={
            sending && capturedUrl ? (
              <div className="cam-frozen">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={capturedUrl} alt="The photo you just took" className="h-full w-full object-cover" />
              </div>
            ) : null
          }
          controls={
            phase.kind === "error" ? (
              <p role="alert" className="note note-bad font-bold">
                {phase.message}
              </p>
            ) : undefined
          }
          busyPanel={
            sending ? (
              <div role="status" aria-live="polite">
                <p className="mb-3 font-bold">Checking your photo</p>
                <ScanChecklist elapsedMs={elapsed} responded={phase.responded} state={phase.state} />
              </div>
            ) : undefined
          }
        />
      )}
    </>
  );
}
