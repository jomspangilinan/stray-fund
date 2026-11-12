"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { boxToView, clampBox } from "@/lib/catDetect";
import { toCatBox, type CatBox } from "@/lib/keepsake";
import { COLONY } from "@/lib/config";
import { showChecklist } from "@/lib/scanSteps";
import type { SpotReveal as Reveal } from "@/server/spotReveal";
import { CaptureCard, CaptureDip, CaptureFlash } from "./CaptureAnimation";
import { LiveCamera, type CaptureLocation } from "./LiveCamera";
import { ScanChecklist } from "./ScanChecklist";
import { SignInGate } from "./SignInGate";
import { SpotReveal } from "./SpotReveal";
import { useCatDetector } from "./useCatDetector";
import { useDevelopPoll } from "./useDevelopPoll";
import { blobToCanvas, maskToPng, usePhoneCut } from "./usePhoneCut";

type Done = {
  state: "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";
  catId: string | null;
  sightingId: string | null;
  message: string;
  /** False on the public path, where no AI looked at the photo. */
  aiChecked?: boolean;
  /** The public photo is already published (the phone cut the cat out). False means the worker is still developing it. */
  developed?: boolean;
  reveal: Reveal | null;
  locationMissing: boolean;
};
type Phase =
  | { kind: "camera" }
  | { kind: "sending"; startedAt: number; responded: boolean; state?: Done["state"]; step: "cutting" | "sending" }
  | { kind: "done"; done: Done }
  | { kind: "error"; message: string }
  /** Close was tapped: the camera is gone at once and the yard is on its way. */
  | { kind: "closing" };

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

/** Shown in place of the camera while the yard loads, so Close answers at once. Focus moves here from the gone button. */
function Closing() {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => line.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-surface px-4">
      <p ref={line} tabIndex={-1} role="status" className="font-bold outline-none">
        Back to the yard…
      </p>
    </div>
  );
}

export function SpotFlow({ username, judge }: { username: string | null; judge: boolean }) {
  const router = useRouter();
  const [phase, setPhaseNow] = useState<Phase>({ kind: "camera" });
  // Once Close is tapped nothing brings the camera back, not even an upload that answers late.
  const closed = useRef(false);
  const setPhase: typeof setPhaseNow = (next) => {
    if (!closed.current) setPhaseNow(next);
  };
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const urlRef = useRef<string | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const detector = useCatDetector(video, phase.kind === "camera" && Boolean(username));
  // Only the public path cuts the cat out on the phone. Judges take the AI path, which does not use a mask.
  const phone = usePhoneCut(!judge && phase.kind === "camera" && Boolean(username));
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

  // A public photo the worker is still developing is polled until it is, so the cat can fill with colour.
  const done = phase.kind === "done" ? phase.done : null;
  const publicNew = Boolean(done && done.aiChecked === false && done.state === "new_cat" && done.reveal);
  const stillDeveloping = publicNew && done?.developed === false;
  const poll = useDevelopPoll(done?.sightingId ?? null, stillDeveloping);

  const fullscreen = phase.kind !== "done" && phase.kind !== "closing" && Boolean(username);

  // Warm the yard once the camera opens, so Close lands quickly.
  const prefetched = useRef(false);
  useEffect(() => {
    if (!fullscreen || prefetched.current) return;
    prefetched.current = true;
    router.prefetch("/");
  }, [fullscreen, router]);

  function close() {
    closed.current = true;
    // Unmounting LiveCamera stops the camera tracks in its cleanup.
    setPhaseNow({ kind: "closing" });
    router.push("/");
  }
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
      <SignInGate>
        <p className="font-bold">Take a photo of a stray cat.</p>
        <p className="soft">We check if the cat is already in the yard, and add it if it is new. Your exact spot stays private.</p>
      </SignInGate>
    );
  }

  async function upload(blob: Blob, where: CaptureLocation, box: CatBox | null) {
    keep(blob);
    const startedAt = Date.now();
    // The phone says it is finding the cat only while it really is: when the model is not ready, the photo just goes up.
    setPhase({ kind: "sending", startedAt, responded: false, step: !judge && phone.ready() ? "cutting" : "sending" });
    const form = new FormData();
    form.set("photo", new File([blob], "cat.jpg", { type: "image/jpeg" }));
    if (where.lat !== null && where.lng !== null) {
      form.set("lat", String(where.lat));
      form.set("lng", String(where.lng));
    }
    // The phone's own cut-out, when it has one in time. Otherwise the photo goes up alone and the server develops it.
    let sendBox = box;
    if (!judge) {
      const canvas = await blobToCanvas(blob);
      const cut = canvas ? await phone.cut(canvas) : null;
      setPhase((p) => (p.kind === "sending" ? { ...p, step: "sending" } : p));
      const png = cut ? await maskToPng(cut.mask) : null;
      if (cut && png) {
        form.set("mask", new File([png], "mask.png", { type: "image/png" }));
        sendBox = cut.box;
      }
    }
    if (sendBox) form.set("box", JSON.stringify(sendBox));
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
        sightingId: body.sightingId ?? null,
        message: body.message,
        aiChecked: body.aiChecked !== false,
        developed: body.developed === true,
        reveal: body.reveal ?? null,
        locationMissing: where.lat === null,
      };
      // Tick every step first, so the list finishes only because the server answered. No AI ran on the public path, so there is nothing to tick.
      if (done.aiChecked) {
        setPhase({ kind: "sending", startedAt, responded: true, state: done.state, step: "sending" });
        await new Promise((r) => setTimeout(r, TICKED_MS));
      }
      setPhase({ kind: "done", done });
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  if (phase.kind === "closing") return <Closing />;

  if (phase.kind === "done") {
    const { done } = phase;
    if (done.reveal && (done.state === "new_cat" || done.state === "matched" || done.state === "needs_review")) {
      return (
        <SpotReveal
          state={done.state}
          catId={done.catId}
          sightingId={done.sightingId}
          reveal={done.reveal}
          capturedUrl={capturedUrl}
          locationMissing={done.locationMissing}
          judge={judge}
          develop={
            publicNew
              ? { developed: !stillDeveloping || poll.developed, soon: poll.soon, photoUrl: poll.photoUrl, avatar: poll.avatar }
              : undefined
          }
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
  const aiPath = showChecklist(judge);
  // The one line under the card. Only the phone's own cut-out earns "Finding your cat…", and only while it runs.
  const sendLabel = phase.kind === "sending" && phase.step === "cutting" ? "Finding your cat…" : "Sending your photo";
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
          scanning={false}
          stageNote={
            sending && capturedUrl ? (
              <CaptureCard photoUrl={capturedUrl} label={aiPath ? null : sendLabel} />
            ) : !(sending && capturedUrl) && detector.state !== "off" ? (
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
              <button type="button" className="cam-chip" onClick={close}>
                Close
              </button>
              <span className="cam-chip">{AREA}</span>
            </>
          }
          overlay={
            sending && capturedUrl ? (
              <>
                <CaptureDip />
                <CaptureFlash />
              </>
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
                {aiPath ? (
                  <>
                    <p className="mb-3 font-bold">Checking your photo</p>
                    <ScanChecklist elapsedMs={elapsed} responded={phase.responded} state={phase.state} />
                  </>
                ) : (
                  <p className="font-bold">{sendLabel}</p>
                )}
              </div>
            ) : undefined
          }
        />
      )}
    </>
  );
}
