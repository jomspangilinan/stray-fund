"use client";

import Link from "next/link";
import { useState } from "react";
import { LiveCamera, type CaptureLocation } from "./LiveCamera";
import { SignIn } from "./SignIn";

type Sex = "unknown" | "female" | "male";
type Done = {
  state: "new_cat" | "matched" | "needs_review" | "rejected" | "queued_for_ai";
  catId: string | null;
  message: string;
  locationMissing: boolean;
};
type Phase = { kind: "camera" } | { kind: "sending" } | { kind: "done"; done: Done } | { kind: "error"; message: string };

const SEXES: { value: Sex; label: string }[] = [
  { value: "unknown", label: "Not sure" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
];

const HEADINGS: Record<Done["state"], string> = {
  new_cat: "A new card",
  matched: "Seen before",
  needs_review: "Thanks, we have it",
  rejected: "We could not use that one",
  queued_for_ai: "Saved",
};

export function CatchFlow({ username }: { username: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const [sex, setSex] = useState<Sex>("unknown");

  if (!username) {
    return (
      <div className="mt-8">
        <p className="mb-4">Sign in so we can link the photo to you.</p>
        <SignIn username={null} inline />
      </div>
    );
  }

  async function upload(blob: Blob, where: CaptureLocation) {
    setPhase({ kind: "sending" });
    const form = new FormData();
    form.set("photo", new File([blob], "cat.jpg", { type: "image/jpeg" }));
    if (where.lat !== null && where.lng !== null) {
      form.set("lat", String(where.lat));
      form.set("lng", String(where.lng));
    }
    if (sex !== "unknown") form.set("sex", sex);
    try {
      const res = await fetch("/api/catch", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as Partial<Done> & { error?: string };
      if (!res.ok || !body.state || !body.message) {
        setPhase({ kind: "error", message: body.error ?? "Could not send the photo. Try again." });
        return;
      }
      setPhase({
        kind: "done",
        done: { state: body.state, catId: body.catId ?? null, message: body.message, locationMissing: where.lat === null },
      });
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  if (phase.kind === "done") {
    const { done } = phase;
    return (
      <div className="mt-8 grid gap-6" role="status">
        <div className={`note ${done.state === "rejected" ? "note-bad" : "note-ok"}`}>
          <h2 className="text-2xl font-extrabold">{HEADINGS[done.state]}</h2>
          <p className="mt-2">{done.message}</p>
          {done.locationMissing && (
            <p className="mt-2 text-dusk">
              Your location was not shared, so this photo is placed at the middle of the colony for now.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          {done.catId && (done.state === "new_cat" || done.state === "matched") && (
            <Link href={`/cats/${done.catId}`} className="btn inline-flex items-center">
              See the card
            </Link>
          )}
          <button type="button" className="btn-quiet" onClick={() => setPhase({ kind: "camera" })}>
            {done.state === "rejected" ? "Try again" : "Catch another"}
          </button>
        </div>
      </div>
    );
  }

  const sending = phase.kind === "sending";
  return (
    <div className="mt-6 grid gap-5">
      <fieldset className="grid gap-2" disabled={sending}>
        <legend className="font-bold">Is it a girl or a boy?</legend>
        <div role="radiogroup" aria-label="Sex" className="flex flex-wrap gap-2">
          {SEXES.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={sex === o.value}
              className="chip !text-base"
              onClick={() => setSex(o.value)}
            >
              {sex === o.value ? "✓ " : ""}
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>
      <LiveCamera onCapture={upload} disabled={sending} />
      {sending && (
        <p role="status" className="font-bold">
          Sending the photo. This can take a few seconds.
        </p>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="note note-bad font-bold">
          {phase.message}
        </p>
      )}
    </div>
  );
}
