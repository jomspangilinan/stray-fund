"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CaptureLocation = { lat: number | null; lng: number | null };

type Facing = "environment" | "user";
type Status = "idle" | "starting" | "ready" | "capturing" | "denied" | "nocamera" | "insecure" | "error";

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.9;
const LOCATION_TIMEOUT_MS = 5000;

/** Resolves with a position, or with nulls on denial, timeout or no support. Never rejects. */
export function locate(): Promise<CaptureLocation> {
  const none: CaptureLocation = { lat: null, lng: null };
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(none);
  return new Promise((resolve) => {
    // Some browsers do not count the permission prompt against the timeout option, so keep our own.
    const timer = setTimeout(() => resolve(none), LOCATION_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(none);
      },
      { timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000, enableHighAccuracy: false },
    );
  });
}

export function toJpeg(video: HTMLVideoElement): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return Promise.resolve(null);
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

function stop(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * A live camera with a shutter. There is deliberately no file picker: photos come only from the camera.
 * The location is asked for when the shutter is pressed, never before, and a missing location still
 * captures (the caller receives nulls).
 */
export function LiveCamera({
  onCapture,
  disabled = false,
  onVideoReady,
  hideShutter = false,
  askLocation = true,
  fullscreen = false,
  topBar,
  overlay,
  controls,
  busyPanel,
  bracketBox = null,
  stageNote,
  scanning = false,
  onStageRect,
}: {
  onCapture: (blob: Blob, where: CaptureLocation) => void | Promise<void>;
  disabled?: boolean;
  /** Called with the playing video element once the camera is live, and with null when it stops. */
  onVideoReady?: (video: HTMLVideoElement | null) => void;
  /** Hides the shutter button, for callers that capture on their own. */
  hideShutter?: boolean;
  /** Off for photos whose place does not matter, so no location prompt appears. */
  askLocation?: boolean;
  /** Fills the screen with corner brackets, a top bar and a bottom panel. The default layout is unchanged. */
  fullscreen?: boolean;
  /** Fullscreen only: the top bar, such as a close link. */
  topBar?: React.ReactNode;
  /** Fullscreen only: drawn over the picture, under the brackets, such as a frozen photo. */
  overlay?: React.ReactNode;
  /** Fullscreen only: extra controls above the shutter. */
  controls?: React.ReactNode;
  /** Fullscreen only: replaces the shutter panel while it is set, such as progress. */
  busyPanel?: React.ReactNode;
  /** Fullscreen only: where the brackets sit, in pixels of the view. Null keeps them centred. */
  bracketBox?: { x: number; y: number; w: number; h: number } | null;
  /** Fullscreen only: a short status shown along the bottom edge of the viewfinder, above the panel. */
  stageNote?: React.ReactNode;
  /** Fullscreen only: sweeps a scan line down the frame. */
  scanning?: boolean;
  /** Fullscreen only: the visible viewfinder in pixels of the view, between the top bar and the panel. */
  onStageRect?: (r: { x: number; y: number; w: number; h: number }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Bumped on every start and on unmount, so a camera that opens late is closed instead of kept.
  const attempt = useRef(0);
  const [status, setStatus] = useState<Status>("idle");
  const [facing, setFacing] = useState<Facing>("environment");
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageTop, setStageTop] = useState(0);
  const stageCb = useRef(onStageRect);
  useEffect(() => {
    stageCb.current = onStageRect;
  });
  const readyCb = useRef(onVideoReady);
  useEffect(() => {
    readyCb.current = onVideoReady;
  });

  // The viewfinder is whatever the top bar and the panel leave free, so the frame follows the panel's height.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStageTop(r.top);
      stageCb.current?.({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [fullscreen]);

  const start = useCallback(async (want: Facing) => {
    const mine = ++attempt.current;
    stop(streamRef.current);
    streamRef.current = null;
    readyCb.current?.(null);
    if (!window.isSecureContext) return setStatus("insecure");
    if (!navigator.mediaDevices?.getUserMedia) return setStatus("nocamera");
    setStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1920 } },
        audio: false,
      });
      if (mine !== attempt.current) return stop(stream);
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      setFacing(want);
      setStatus("ready");
      if (video) readyCb.current?.(video);
    } catch (e) {
      if (mine !== attempt.current) return;
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") setStatus("denied");
      else if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
        setStatus("nocamera");
      } else setStatus("error");
    }
  }, []);

  useEffect(
    () => () => {
      attempt.current++;
      stop(streamRef.current);
      streamRef.current = null;
      readyCb.current?.(null);
    },
    [],
  );

  async function shoot() {
    const video = videoRef.current;
    if (!video || status !== "ready") return;
    setStatus("capturing");
    const blob = await toJpeg(video);
    if (!blob) {
      setStatus("error");
      return;
    }
    const where: CaptureLocation = askLocation ? await locate() : { lat: null, lng: null };
    await onCapture(blob, where);
    setStatus("ready");
  }

  const live = status === "ready" || status === "capturing";

  const canRetry = !live && (status === "idle" || status === "denied" || status === "error" || status === "nocamera");

  // Shown in the middle of the empty viewfinder, next to its hint, so it is the one obvious action.
  const openButton = canRetry ? (
    <button
      type="button"
      className="btn min-h-14 min-w-56 px-8 text-lg"
      onClick={() => start(facing)}
      disabled={disabled}
    >
      {status === "idle" ? "Open camera" : "Try again"}
    </button>
  ) : null;

  const buttons = live ? (
    <div className="flex flex-wrap gap-3">
      {!hideShutter && (
        <button
          type="button"
          className={`btn ${fullscreen ? "flex-1" : ""}`}
          onClick={shoot}
          disabled={disabled || status === "capturing"}
        >
          {status === "capturing" ? "Taking photo" : "Take photo"}
        </button>
      )}
      <button
        type="button"
        className="btn-quiet"
        onClick={() => start(facing === "environment" ? "user" : "environment")}
        disabled={disabled || status === "capturing"}
      >
        {facing === "environment" ? "Use front camera" : "Use back camera"}
      </button>
    </div>
  ) : null;

  if (fullscreen) {
    return (
      <div className="cam-full on-main">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-label="Live camera"
          className={`absolute inset-0 h-full w-full object-cover ${live ? "" : "invisible"}`}
        />
        {overlay}
        <div className="cam-top">{topBar}</div>
        <div className="cam-stage" ref={stageRef}>
          {!live && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8 text-center text-white">
              <CameraMessage status={status} />
              {openButton}
            </div>
          )}
          {(live || overlay) &&
            (bracketBox ? (
              <div
                className="cam-brackets locked"
                style={{ left: bracketBox.x, top: bracketBox.y - stageTop, width: bracketBox.w, height: bracketBox.h }}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
                <i />
                {scanning && <div className="scan-line" />}
              </div>
            ) : (
              <div className="cam-frame-area">
                <div className="cam-brackets" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  {scanning && <div className="scan-line" />}
                </div>
              </div>
            ))}
          {stageNote}
        </div>
        <div className="cam-bottom">
          {busyPanel ?? (
            <>
              {controls}
              {buttons}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="relative aspect-[3/4] max-h-[60dvh] w-full overflow-hidden rounded-out bg-ink">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-label="Live camera"
          className={`h-full w-full object-cover ${live ? "" : "invisible"}`}
        />
        {!live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-6 text-center text-white">
            <CameraMessage status={status} />
            {openButton}
          </div>
        )}
      </div>

      {buttons}
    </div>
  );
}

function CameraMessage({ status }: { status: Status }) {
  switch (status) {
    case "starting":
      return <p role="status">Starting the camera. Allow access if your browser asks.</p>;
    case "denied":
      return (
        <div role="alert" className="grid gap-2">
          <p className="font-bold">The camera is blocked.</p>
          <p>
            To turn it on, open your browser&apos;s site settings for this page, set Camera to Allow, then come
            back and tap Try again. Photos can only be taken live with the camera.
          </p>
        </div>
      );
    case "nocamera":
      return (
        <div role="alert" className="grid gap-2">
          <p className="font-bold">No camera found.</p>
          <p>This device has no camera we can use. Open this page on a phone to take a photo.</p>
        </div>
      );
    case "insecure":
      return (
        <div role="alert" className="grid gap-2">
          <p className="font-bold">The camera needs a secure page.</p>
          <p>Open this site with an address that starts with https:// and try again.</p>
        </div>
      );
    case "error":
      return (
        <p role="alert">Something went wrong with the camera. Tap Try again, or close other apps that use it.</p>
      );
    default:
      return <p>Point the camera at the cat, then take the photo.</p>;
  }
}
