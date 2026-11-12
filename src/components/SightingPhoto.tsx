"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Rotate left and Rotate right for one sighting's photo. `onTurned` runs after the server has turned it, so the
 * caller can reload its picture. The buttons keep their taps to themselves, so a swipe card or the cats browser
 * around them never reads a tap as the start of a swipe.
 */
export function RotateButtons({ sightingId, onTurned }: { sightingId: string; onTurned?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rotate(direction: "left" | "right") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/caretaker/photo_rotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sightingId, direction }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.ok && json.ok === true) {
        onTurned?.();
        router.refresh();
      } else setError(json.message ?? "Something went wrong. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const keep = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <>
      <div className="mt-2 flex gap-3">
        <button type="button" className="btn-quiet flex-1" disabled={busy} onPointerDown={keep} onClick={() => void rotate("left")}>
          Rotate left
        </button>
        <button type="button" className="btn-quiet flex-1" disabled={busy} onPointerDown={keep} onClick={() => void rotate("right")}>
          Rotate right
        </button>
      </div>
      {error && (
        <p role="alert" className="small mt-2">
          {error}
        </p>
      )}
    </>
  );
}

/** A sighting's private photo with Rotate left and Rotate right, for a photo that came out sideways. */
export function SightingPhoto({ sightingId, alt, className }: { sightingId: string; alt: string; className: string }) {
  const [version, setVersion] = useState(0);
  return (
    <div className="mt-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route */}
      <img
        src={`/api/caretaker/images/sighting/${sightingId}${version ? `?r=${version}` : ""}`}
        alt={alt}
        draggable={false}
        className={className}
      />
      <RotateButtons sightingId={sightingId} onTurned={() => setVersion((v) => v + 1)} />
    </div>
  );
}
