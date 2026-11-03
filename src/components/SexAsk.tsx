"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Answer = "female" | "male";

const OPTIONS: { value: Answer; label: string }[] = [
  { value: "female", label: "Girl" },
  { value: "male", label: "Boy" },
];

/**
 * "Girl or boy?" for a cat whose card does not say yet. One tap sends it. If someone answered first, the
 * reply says what the sex is and that is what shows. `onSex` lets the reveal pop the ribbon.
 */
export function SexAsk({ catId, onSex, refresh = false }: { catId: string; onSex?: (sex: "female" | "male" | "unknown") => void; refresh?: boolean }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function pick(next: Answer) {
    if (next === picked || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cats/${catId}/sex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { sex?: string };
      if (!res.ok || (body.sex !== "female" && body.sex !== "male")) {
        setNote("Could not save that. Try again.");
        return;
      }
      setPicked(body.sex);
      setNote("Saved. Thanks.");
      onSex?.(body.sex);
      if (refresh) router.refresh();
    } catch {
      setNote("Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-bold">Girl or boy?</legend>
      <div role="radiogroup" aria-label="Girl or boy" className="flex flex-wrap gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={picked === o.value}
            disabled={busy}
            className="chip"
            onClick={() => pick(o.value)}
          >
            {picked === o.value ? "✓ " : ""}
            {o.label}
          </button>
        ))}
      </div>
      <p className="small soft" role="status">
        {note ?? "Optional."}
      </p>
    </fieldset>
  );
}
