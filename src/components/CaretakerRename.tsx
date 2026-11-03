"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseCatName, renameReply } from "@/lib/catNames";

/** The pencil panel for a caretaker: type the name and it is set at once. It closes any waiting ideas for this cat. */
export function CaretakerRename({ catId, name, onSaved }: { catId: string; name: string; onSaved: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
      const res = await fetch("/api/caretaker/cat_rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catId, name: parsed.name }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || json.ok !== true) {
        setProblem(json.message ?? "Could not save that. Try again.");
        return;
      }
      const reply = renameReply(json.message);
      router.refresh();
      if (reply.close) onSaved();
      else setProblem(reply.note);
    } catch {
      setProblem("Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3" noValidate>
      <label className="grid gap-1">
        <span className="sr-only">Name</span>
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
          aria-describedby="rename-note"
        />
      </label>
      <button type="submit" className="btn" disabled={busy || value.trim() === "" || value.trim() === name || Boolean(invalid)}>
        {busy ? "Working" : "Save name"}
      </button>
      <p id="rename-note" className="small" role="status">
        {problem ?? invalid ?? ""}
      </p>
    </form>
  );
}
