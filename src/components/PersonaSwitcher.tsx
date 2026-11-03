"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const PERSONAS = [
  { key: "caretaker", label: "Caretaker", username: "demo_caretaker" },
  { key: "vet", label: "Vet", username: "demo_vet" },
] as const;

/** Demo only. The layout renders this only when DEMO_MODE is on; the API checks it again. */
export function PersonaSwitcher({ current }: { current: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function pick(key: string) {
    setError(null);
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: key }),
    });
    if (!res.ok) {
      setError("Could not switch");
      return;
    }
    router.refresh();
  }

  return (
    <div className="border-b-2 border-ink bg-sign">
      <div className="mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <span className="font-bold">Demo view</span>
        <div role="group" aria-label="View the app as" className="flex gap-2">
          {PERSONAS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => pick(p.key)}
              aria-pressed={current === p.username}
              className="min-h-9 rounded-md border-2 border-ink px-3 font-bold aria-pressed:bg-ink aria-pressed:text-paper"
            >
              {p.label}
            </button>
          ))}
        </div>
        {error && (
          <span role="alert" className="font-bold">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
