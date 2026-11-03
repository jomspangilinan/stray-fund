"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseCatName } from "@/lib/catNames";

/**
 * "Know their name?" for a signed-in person. The name waits for a caretaker and changes nothing public. The
 * person sees their own pending idea here and nobody else's. A decided one just disappears, with no message.
 */
export function NameSuggest({ catId, pending }: { catId: string; pending: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Checked while typing, so a wrong letter is named before Send.
  const check = value.trim() === "" ? null : parseCatName(value);
  const invalid = check && !check.ok ? check.message : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseCatName(value);
    if (!parsed.ok) {
      setProblem(parsed.message);
      return;
    }
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/cats/${catId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: parsed.name }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setProblem(json.error ?? "Could not save that. Try again.");
        return;
      }
      setSent(true);
      setValue("");
      router.refresh();
    } catch {
      setProblem("Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="know-name" className="card">
      <h2 id="know-name" className="h2 mb-2">
        Know their name?
      </h2>
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <label className="grid gap-1">
          <span className="sr-only">Their name</span>
          <input
            className="field"
            name="name"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSent(false);
              setProblem(null);
            }}
            maxLength={60}
            autoComplete="off"
            aria-invalid={invalid ? true : undefined}
            aria-describedby="know-name-note"
          />
        </label>
        <button type="submit" className="btn" disabled={busy || value.trim() === "" || Boolean(invalid)}>
          {busy ? "Working" : "Send"}
        </button>
        <p id="know-name-note" className="small" role="status">
          {problem ?? invalid ?? (sent ? "Thanks. A caretaker will check it." : pending ? `Your suggestion: ${pending}. A caretaker will check it.` : "")}
        </p>
      </form>
    </section>
  );
}
