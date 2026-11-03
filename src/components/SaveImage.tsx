"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { keepsakeFileName, type KeepsakeData } from "@/lib/keepsake";
import { createJob, handOver } from "@/lib/keepsakeJob";

async function build(catId: string, signal: AbortSignal): Promise<File> {
  const res = await fetch(`/api/cats/${catId}/keepsake`, { signal });
  if (!res.ok) throw new Error("data");
  const data = (await res.json()) as KeepsakeData;
  const photo = await fetch(data.photo, { signal });
  if (!photo.ok) throw new Error("photo");
  const { composeKeepsake } = await import("@/lib/keepsakeCanvas");
  const png = await composeKeepsake(data, await photo.blob());
  return new File([png], keepsakeFileName(data.name), { type: "image/png" });
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const BACKGROUND_NOTE = "Check the background before you share.";

const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 19h14" />
  </svg>
);

/**
 * Saves the cat's picture. The picture is built in the background once this scrolls into view, so a tap on a ready
 * button opens the share sheet at once (an iPhone then offers Save Image); elsewhere the file downloads. A tap before
 * it is ready shows a spinner, then "Tap to save". A background failure stays silent until someone taps.
 * "icon": a 44px button over the top right of the photo it wraps. "button": a full-width outline button under the
 * card it wraps, for a photo too small to carry one. Either way "Check the background before you share." is plain
 * text right under it, on screen before any tap. The status is read aloud from a live region that is mounted empty,
 * filled on each change, and kept off screen.
 */
export function SaveImage({
  catId,
  children,
  variant,
}: {
  catId: string;
  children: React.ReactNode;
  variant: "icon" | "button";
}) {
  const [job] = useState(() => createJob((signal) => build(catId, signal)));
  const state = useSyncExternalStore(job.subscribe, job.state, () => "idle" as const);
  // Someone tapped before the picture was ready, so they are waiting on it.
  const [waiting, setWaiting] = useState(false);
  const [again, setAgain] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      job.start();
      return;
    }
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        job.start();
        seen.disconnect();
      }
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [job]);

  function tap() {
    const file = job.file();
    if (state === "ready" && file) {
      // Nothing is awaited before the share call inside handOver.
      setWaiting(false);
      void handOver(file, navigator, download).then((r) => setAgain(r === "again"));
      return;
    }
    if (state === "failed") {
      job.retry();
    } else job.start();
    setWaiting(true);
  }

  const saving = state === "building" && waiting;
  const label = saving ? "Saving" : state === "ready" && waiting ? "Tap to save" : "Save image";
  // The status line says something only while there is something to say.
  const status =
    waiting && state === "failed"
      ? "Could not make the image. Check your connection and tap save again."
      : again
        ? "Tap save once more."
        : saving || (state === "ready" && waiting)
          ? `${label}.`
          : "";
  const icon = saving ? <span className="save-spin" aria-hidden="true" /> : DOWNLOAD_ICON;
  return (
    <div ref={box}>
      <div className="relative">
        {children}
        {variant === "icon" && (
          <button type="button" className="save-icon absolute right-2 top-2 z-10" aria-label={label} aria-busy={saving} disabled={saving} onClick={tap}>
            {icon}
          </button>
        )}
      </div>
      {variant === "button" && (
        <button type="button" className="save-btn mt-3" aria-busy={saving} disabled={saving} onClick={tap}>
          {icon}
          {label}
        </button>
      )}
      <p className="save-note">{BACKGROUND_NOTE}</p>
      <p className="sr-only" role="status">
        {status}
      </p>
    </div>
  );
}
