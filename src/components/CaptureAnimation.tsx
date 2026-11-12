import type { CSSProperties } from "react";
import { CAPTURE_TOTAL_MS } from "@/lib/scanSteps";

/** A white flash that fades at once. Transform and opacity only; it never takes a tap. */
export function CaptureFlash() {
  return <div className="cap-flash" aria-hidden="true" />;
}

/** The viewfinder dips to dark under the flash, so the camera stops looking live. */
export function CaptureDip() {
  return <div className="cap-dip" aria-hidden="true" />;
}

/**
 * The frame, now a white-bordered card that drops in with a tilt and settles. `label` is the one honest line under
 * it ("Finding your cat…" while the phone cuts the cat out, "Developing…" while the server does); it is the caller's
 * to give and null when there is nothing true to say. The card pulses once the first CAPTURE_TOTAL_MS have passed.
 */
export function CaptureCard({ photoUrl, label }: { photoUrl: string; label: string | null }) {
  return (
    <div className="cap-layer" style={{ "--cap-total": `${CAPTURE_TOTAL_MS}ms` } as CSSProperties}>
      <div className="cap-card">
        <div className="cap-photo">
          {/* A device photo is a blob: URL, so next/image adds nothing. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt="The photo you just took" className="h-full w-full object-cover" />
        </div>
        {label && (
          <p className="cap-label" aria-hidden="true">
            {label}
          </p>
        )}
      </div>
    </div>
  );
}
