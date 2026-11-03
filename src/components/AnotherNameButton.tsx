"use client";

import { useState } from "react";

/**
 * For the finder of a cat. One tap sets a free name from our own list at once. The server decides who may,
 * and stops once a caretaker has named the cat, so this only reports what came back.
 */
export function AnotherNameButton({ catId, onNamed }: { catId: string; onNamed: (name: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function tap() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cats/${catId}/another-name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
      if (res.ok && json.name) onNamed(json.name);
      else setNote(json.error ?? "Could not change the name. Try again.");
    } catch {
      setNote("Could not change the name. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <button type="button" className="btn-quiet" onClick={tap} disabled={busy}>
        {busy ? "Working" : "Another name"}
      </button>
      {note && (
        <p role="alert" className="small text-center">
          {note}
        </p>
      )}
    </div>
  );
}
