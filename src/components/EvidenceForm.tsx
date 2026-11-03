"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LiveCamera } from "./LiveCamera";

const MAX_BYTES = 10 * 1024 * 1024;

type Result = { verification: "verified" | "needs_review" | "rejected" | "pending"; message: string; messages: string[] };

const HEADINGS: Record<Result["verification"], string> = {
  verified: "Verified",
  needs_review: "A caretaker will look",
  rejected: "Not accepted",
  pending: "Saved",
};

/** The receipt comes from a file. The ear photo comes only from the live camera, so it is a photo of the cat in front of you. */
export function EvidenceForm({ bookingId, catName }: { bookingId: string; catName: string }) {
  const router = useRouter();
  const [receipt, setReceipt] = useState<File | null>(null);
  const [earPhoto, setEarPhoto] = useState<Blob | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  function pickReceipt(file: File | undefined) {
    setFileError(null);
    setReceipt(null);
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") return setFileError("The receipt must be a JPEG or PNG.");
    if (file.size > MAX_BYTES) return setFileError("That file is over 10 MB. Take a smaller photo.");
    setReceipt(file);
  }

  async function send() {
    if (!receipt || !earPhoto) return;
    setSending(true);
    setError(null);
    const form = new FormData();
    form.set("receipt", receipt);
    form.set("earTipPhoto", new File([earPhoto], "ear.jpg", { type: "image/jpeg" }));
    try {
      const res = await fetch(`/api/vet/bookings/${bookingId}/evidence`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as Partial<Result> & { error?: string };
      if (!res.ok || !body.verification || !body.message) {
        setError(body.error ?? "Could not send the evidence. Try again.");
        return;
      }
      setResult({ verification: body.verification, message: body.message, messages: body.messages ?? [] });
      setReceipt(null);
      setEarPhoto(null);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (result) {
    const canRetry = result.verification === "needs_review" || result.verification === "rejected";
    return (
      <div className="grid gap-4" role="status">
        <div className={`note ${result.verification === "rejected" ? "note-bad" : result.verification === "verified" ? "note-ok" : ""}`}>
          <h3 className="text-2xl font-extrabold">{HEADINGS[result.verification]}</h3>
          <p className="mt-2">{result.message}</p>
          {result.messages.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {result.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
        {canRetry && (
          <button type="button" className="btn-quiet" onClick={() => setResult(null)}>
            Send a new photo
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <label htmlFor="receipt" className="font-bold">
          Photo of the receipt
        </label>
        <p className="text-sm text-dusk">The whole receipt, flat and in good light. JPEG or PNG, up to 10 MB.</p>
        <input
          id="receipt"
          type="file"
          accept="image/jpeg,image/png"
          className="field"
          disabled={sending}
          onChange={(e) => pickReceipt(e.target.files?.[0])}
        />
        {fileError && (
          <p role="alert" className="note note-bad font-bold">
            {fileError}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-xl font-extrabold">Photo of {catName} after surgery</h3>
        <p className="text-sm text-dusk">Show the tipped ear and the coat, so we can tell it is the same cat.</p>
        {earPhoto ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="note note-ok font-bold">Photo taken.</p>
            <button type="button" className="btn-quiet" disabled={sending} onClick={() => setEarPhoto(null)}>
              Take it again
            </button>
          </div>
        ) : (
          <LiveCamera onCapture={(blob) => setEarPhoto(blob)} disabled={sending} askLocation={false} />
        )}
      </div>

      <button type="button" className="btn" disabled={!receipt || !earPhoto || sending} onClick={send}>
        {sending ? "Checking. This can take a little while." : "Send for checking"}
      </button>
      {error && (
        <p role="alert" className="note note-bad font-bold">
          {error}
        </p>
      )}
    </div>
  );
}
