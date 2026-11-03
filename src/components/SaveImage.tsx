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

/**
 * One quiet button over the photo it wraps. The picture is built in the background once the button scrolls into view,
 * so a tap on a ready button opens the share sheet at once (an iPhone then offers Save Image); elsewhere the file
 * downloads. The reminder to check the background is on screen the whole time, so it is read before any tap. A tap
 * before the picture is ready shows "Saving", then "Tap to save". A background failure stays silent until someone taps.
 * The status sits in a live region that is mounted empty and filled, so a screen reader announces each change.
 * `note` says where the lines go: "over" the bottom of the photo, or "below" what it wraps.
 */
export function SaveImage({
  catId,
  children,
  iconClass,
  note,
}: {
  catId: string;
  children: React.ReactNode;
  iconClass: string;
  note: "over" | "below";
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
  return (
    <div ref={box} className="relative">
      {children}
      <button type="button" className={`save-icon absolute z-10 ${iconClass}`} aria-label={label} aria-busy={saving} disabled={saving} onClick={tap}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 19h14" />
        </svg>
      </button>
      <div className={note === "over" ? "save-lines save-over" : "save-lines save-below"}>
        <p className="save-line small" role="status">
          {status}
        </p>
        <p className="save-line small">{BACKGROUND_NOTE}</p>
      </div>
    </div>
  );
}
