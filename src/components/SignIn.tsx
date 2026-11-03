"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Header control when compact, a full form when inline. Sign-in needs only a username. */
export function SignIn({ username, inline = false }: { username: string | null; inline?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" });
    router.refresh();
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not sign in");
        return;
      }
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (username && !inline) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="max-w-[9rem] truncate font-bold">{username}</span>
        <button type="button" onClick={signOut} className="underline underline-offset-4">
          Sign out
        </button>
      </div>
    );
  }
  if (username) return null;

  const form = (
    <form onSubmit={signIn} className="grid gap-2" noValidate>
      <label htmlFor={inline ? "username-inline" : "username"} className="font-bold">
        Pick a username
      </label>
      <div className="flex gap-2">
        <input
          id={inline ? "username-inline" : "username"}
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={20}
          aria-describedby={error ? "signin-error" : "signin-help"}
        />
        <button className="btn shrink-0" disabled={busy || name.length < 3}>
          Continue
        </button>
      </div>
      <p id="signin-help" className="text-sm text-dusk">
        3 to 20 letters, digits or underscores. No password. Use the same name to come back.
      </p>
      {error && (
        <p id="signin-error" role="alert" className="font-bold text-chili">
          {error}
        </p>
      )}
    </form>
  );

  if (inline) return form;
  return (
    <details className="relative">
      <summary className="btn-quiet inline-flex cursor-pointer list-none items-center">Sign in</summary>
      <div className="ticket absolute right-0 z-10 mt-3 w-[min(20rem,calc(100vw-2rem))]">{form}</div>
    </details>
  );
}
