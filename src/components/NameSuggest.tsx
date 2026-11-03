"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseCatName } from "@/lib/catNames";

/**
 * The name field inside the pencil panel, for a signed-in person. The name waits for a caretaker and changes
 * nothing public. The pencil's owner shows the person's own pending idea, and nobody else's.
 */
export function NameSuggest({
  catId,
  onSent,
}: {
  catId: string;
  onSent: (name: string) => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
      setValue("");
      onSent(parsed.name);
      router.refresh();
    } catch {
      setProblem("Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3" noValidate>
      <label className="grid gap-1">
        <span className="sr-only">Their name</span>
        <input
          className="field"
          name="name"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setProblem(null);
          }}
          maxLength={60}
          autoComplete="off"
          aria-invalid={invalid ? true : undefined}
          aria-describedby="know-name-note"
        />
      </label>
      <button
        type="submit"
        className="btn"
        disabled={busy || value.trim() === "" || Boolean(invalid)}
      >
        {busy ? "Working" : "Send"}
      </button>
      <p id="know-name-note" className="small" role="status">
        {problem ?? invalid ?? ""}
      </p>
    </form>
  );
}
