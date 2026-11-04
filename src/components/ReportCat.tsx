"use client";

import { useId, useState } from "react";

type Claim = "injured" | "pregnant" | "sick" | "kitten";

const CHIPS: { claim: Claim; label: string }[] = [
  { claim: "injured", label: "Hurt" },
  { claim: "pregnant", label: "Looks pregnant" },
  { claim: "sick", label: "Looks sick" },
  { claim: "kitten", label: "Kitten" },
];

const NOTE_MAX = 280;
const THANKS = "Thanks. A caretaker will check.";

type Answer = { ok: true; message?: string } | { ok: false; error: string };

async function send(sightingId: string, claim: Claim, note: string): Promise<Answer> {
  try {
    const res = await fetch("/api/spot/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sightingId, claim, ...(note.trim() ? { note: note.trim() } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (res.ok && body.ok) return { ok: true, message: body.message };
    return { ok: false, error: body.error ?? "Could not send that. Try again." };
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
}

/**
 * After a photo is sent: tell a caretaker something is wrong with the cat in it. It only exists on the reveal,
 * which only exists after a photo, and the report is tied to that photo by the sighting id. Pick any that fit,
 * add a detail if you like, send. One request goes out per pick; each one that is sent leaves the list, so a
 * failure keeps only what still needs sending.
 */
export function ReportCat({ sightingId, photo }: { sightingId: string; photo: string | null }) {
  const [picked, setPicked] = useState<Claim[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const noteId = useId();

  function toggle(c: Claim) {
    setError(null);
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    let filed = false;
    let repeat: string | null = null;
    let failure: string | null = null;
    const left: Claim[] = [];
    for (const claim of picked) {
      const a = await send(sightingId, claim, note);
      if (!a.ok) {
        failure ??= a.error;
        left.push(claim);
      } else if (a.message) repeat ??= a.message;
      else filed = true;
    }
    setBusy(false);
    if (failure) {
      setPicked(left);
      setError(failure);
      return;
    }
    setDone(filed ? THANKS : (repeat ?? THANKS));
  }

  if (done) {
    return (
      <p className="reveal-more font-bold" role="status">
        {done}
      </p>
    );
  }

  return (
    <section className="reveal-more grid gap-3" aria-labelledby={`${noteId}-h`}>
      <div className="flex items-center gap-3">
        {photo && (
          // The photo just taken, kept on this device, so it is the evidence the report rests on.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="The photo this report is about" className="h-14 w-14 flex-none rounded-in bg-pale object-cover" />
        )}
        <div>
          <h2 id={`${noteId}-h`} className="font-extrabold leading-tight">
            Is something wrong?
          </h2>
          <p className="small soft">Tap any that fit.</p>
        </div>
      </div>
      <div role="group" aria-labelledby={`${noteId}-h`} className="flex flex-wrap gap-2">
        {CHIPS.map((c) => {
          const on = picked.includes(c.claim);
          return (
            <button key={c.claim} type="button" className="chip" role="checkbox" aria-checked={on} disabled={busy} onClick={() => toggle(c.claim)}>
              {on ? "✓ " : ""}
              {c.label}
            </button>
          );
        })}
      </div>
      {picked.length > 0 && (
        <>
          <div className="grid gap-1">
            <label htmlFor={noteId} className="small font-bold">
              Add a detail (only caretakers see this)
            </label>
            <textarea
              id={noteId}
              className="field"
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button type="button" className="btn" disabled={busy} onClick={submit}>
            {busy ? "Sending" : "Send to a caretaker"}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="note note-bad font-bold">
          {error}
        </p>
      )}
    </section>
  );
}
