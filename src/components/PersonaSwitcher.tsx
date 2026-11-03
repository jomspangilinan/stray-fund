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
    <div className="bg-pale">
      <div className="mx-auto flex max-w-2xl items-center gap-x-2 px-4 py-1 text-[0.8125rem]">
        <span className="font-semibold text-soft">Demo view</span>
        <div role="group" aria-label="View the app as" className="flex gap-1">
          {PERSONAS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => pick(p.key)}
              aria-pressed={current === p.username}
              className="press min-h-8 rounded-in px-2.5 font-bold text-main aria-pressed:bg-main aria-pressed:text-white"
            >
              {p.label}
            </button>
          ))}
        </div>
        {error && (
          <span role="alert" className="font-bold text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
