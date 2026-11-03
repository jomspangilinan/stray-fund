"use client";

import { useRef, useState } from "react";
import { keepsakeFileName, type KeepsakeData } from "@/lib/keepsake";

type Phase = "idle" | "saving" | "failed" | "again";

/**
 * One quiet button that makes a picture of the cat in the courtyard and hands it over. The share sheet comes first
 * (on an iPhone it offers Save Image); anywhere else the file downloads. The reminder shows only with the button.
 */
export function SaveImage({ catId }: { catId: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const made = useRef<File | null>(null);

  async function hand(file: File) {
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "done";
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return "done";
        // A long wait can use up the tap's permission to share. The picture is ready, so the next tap is instant.
        if (e instanceof DOMException && e.name === "NotAllowedError") return "again";
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return "done";
  }

  async function save() {
    if (phase === "saving") return;
    setPhase("saving");
    try {
      if (!made.current) {
        const res = await fetch(`/api/cats/${catId}/keepsake`);
        if (!res.ok) throw new Error("data");
        const data = (await res.json()) as KeepsakeData;
        const photo = await fetch(data.photo);
        if (!photo.ok) throw new Error("photo");
        const { composeKeepsake } = await import("@/lib/keepsakeCanvas");
        const png = await composeKeepsake(data, await photo.blob());
        made.current = new File([png], keepsakeFileName(data.name), { type: "image/png" });
      }
      setPhase((await hand(made.current)) === "again" ? "again" : "idle");
    } catch {
      setPhase("failed");
    }
  }

  return (
    <div className="grid justify-items-center gap-1">
      <button type="button" className="btn-quiet" disabled={phase === "saving"} aria-busy={phase === "saving"} onClick={save}>
        {phase === "saving" ? "Saving" : "Save image"}
      </button>
      {phase === "failed" && (
        <p className="small text-center" role="alert">
          Could not make the image. Check your connection and tap Save image again.
        </p>
      )}
      {phase === "again" && (
        <p className="small text-center" role="status">
          The image is ready. Tap Save image once more.
        </p>
      )}
      <p className="small soft text-center">Check the background before you share.</p>
    </div>
  );
}
