"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export const CLEAR_QUESTION = "Clear this cat for surgery? You've seen this cat.";

/** A vet says they have seen the cat and it can go to surgery. The server decides whether that is allowed. */
export function ClearCatButton({ catId, catName }: { catId: string; catName: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/vet/cats/${catId}/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      // A repeat tap finds nothing waiting: the list refreshes and the cat is gone, which is what the vet wanted.
      if (res.ok || res.status === 409) {
        router.refresh();
        return;
      }
      setError(body.error ?? "Could not clear that cat. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-4 grid gap-2">
      {asking ? (
        <div role="group" aria-label="Check before clearing" className="note grid gap-3">
          <p className="font-bold">{CLEAR_QUESTION}</p>
          <div className="flex gap-3">
            <button type="button" className="btn flex-1" onClick={clear} disabled={sending}>
              {sending ? "Clearing" : "Clear"}
            </button>
            <button type="button" className="btn-quiet flex-1" onClick={() => setAsking(false)} disabled={sending}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setAsking(true)}>
          {`Clear ${catName} for surgery`}
        </button>
      )}
      {error && (
        <p role="alert" className="note note-bad font-bold">
          {error}
        </p>
      )}
    </div>
  );
}
