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

/**
 * One quiet button. The picture is built in the background once the button scrolls into view, so a tap on a
 * ready button opens the share sheet at once (an iPhone then offers Save Image); elsewhere the file downloads.
 * A tap before it is ready shows "Saving", then "Tap to save". A background failure stays silent until someone taps.
 */
export function SaveImage({ catId }: { catId: string }) {
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
  return (
    <div ref={box} className="grid justify-items-center gap-1">
      <button type="button" className="btn-quiet" disabled={saving} aria-busy={saving} onClick={tap}>
        {label}
      </button>
      {waiting && state === "failed" && (
        <p className="small text-center" role="alert">
          Could not make the image. Check your connection and tap Save image again.
        </p>
      )}
      {again && (
        <p className="small text-center" role="status">
          Tap Save image once more.
        </p>
      )}
      <p className="small soft text-center">Check the background before you share.</p>
    </div>
  );
}
