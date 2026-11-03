"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Header control when compact, a full form when inline. Sign-in needs only a username.
 * A signed-in caretaker or vet also finds their console link in the account menu.
 */
export function SignIn({
  username,
  inline = false,
  console: consoleLink = null,
  showName = true,
}: {
  username: string | null;
  /** Whether the username may appear in thanks. */
  showName?: boolean;
  inline?: boolean;
  console?: { href: string; label: string } | null;
}) {
  const router = useRouter();
  const menu = useRef<HTMLDetailsElement>(null);

  // A floating menu closes on an outside tap or Escape.
  useEffect(() => {
    const close = (e: Event) => {
      const el = menu.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && e.target instanceof Node && el.contains(e.target)) return;
      el.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(showName);

  async function toggleName() {
    const next = !shown;
    setShown(next);
    const res = await fetch("/api/account/thanks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ show: next }),
    }).catch(() => null);
    if (!res?.ok) setShown(!next);
    else router.refresh();
  }

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
      <details ref={menu} className="relative">
        <summary
          aria-label={`Account, signed in as ${username}`}
          className="press grid h-11 w-11 cursor-pointer list-none place-items-center rounded-in bg-pale text-sm font-extrabold text-main [&::-webkit-details-marker]:hidden"
        >
          {username.slice(0, 2).toUpperCase()}
        </summary>
        <div className="absolute right-0 z-40 mt-2 grid w-[min(16rem,calc(100vw-2rem))] gap-1 rounded-out bg-surface p-2 shadow-[0_8px_30px_rgba(18,53,42,0.18)]">
          <p className="truncate px-3 pt-2 font-bold">{username}</p>
          {consoleLink && (
            <Link href={consoleLink.href} className="press flex min-h-12 items-center rounded-in px-3 font-bold text-main" onClick={() => menu.current?.removeAttribute("open")}>
              {consoleLink.label}
            </Link>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={shown}
            onClick={toggleName}
            className="press flex min-h-12 w-full items-center justify-between gap-3 rounded-in px-3 text-left font-semibold"
          >
            <span>Show my name in thanks and the ledger</span>
            <span aria-hidden="true" className="tag flex-none">
              {shown ? "On" : "Off"}
            </span>
          </button>
          <button type="button" onClick={signOut} className="press flex min-h-12 w-full items-center rounded-in px-3 text-left font-semibold">
            Sign out
          </button>
        </div>
      </details>
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
      <p id="signin-help" className="small soft">
        3 to 20 letters, digits or underscores. No password. Use the same name to come back.
      </p>
      {error && (
        <p id="signin-error" role="alert" className="font-bold text-danger">
          {error}
        </p>
      )}
    </form>
  );

  if (inline) return form;
  return (
    <details ref={menu} className="relative">
      <summary className="btn-quiet cursor-pointer list-none [&::-webkit-details-marker]:hidden">Sign in</summary>
      <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-out bg-surface p-4 shadow-[0_8px_30px_rgba(18,53,42,0.18)]">{form}</div>
    </details>
  );
}
