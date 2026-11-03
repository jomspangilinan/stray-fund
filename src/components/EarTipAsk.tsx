"use client";

import { useState } from "react";
import { EarTipChoice, type EarTipAnswer } from "./EarTipChoice";

/** On a cat card, for a signed-in neighbour. One tap sends the answer. It shows only this person's own answer. */
export function EarTipAsk({ catId, initial }: { catId: string; initial: EarTipAnswer }) {
  const [answer, setAnswer] = useState<EarTipAnswer>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function pick(next: EarTipAnswer) {
    if (next === answer) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/cats/${catId}/ear-tip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: next }),
      });
      if (!res.ok) {
        setNote("Could not save that. Try again.");
        return;
      }
      setAnswer(next);
      setNote("Saved. Thanks.");
    } catch {
      setNote("Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="eartip" className="card">
      <h2 id="eartip" className="h2 mb-2">
        Does this cat have a tipped ear?
      </h2>
      <EarTipChoice value={answer} onChange={pick} disabled={busy} legend="Your answer" />
      <p className="small soft mt-2" role="status">
        {note ?? "Only you see your answer."}
      </p>
    </section>
  );
}
