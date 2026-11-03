"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SignIn } from "./SignIn";

/**
 * What a signed-out visitor sees on Spot, Donate and Helped: what the page does, then one tap into the demo
 * (the existing simulated caretaker account) or a typed name. Signing in refreshes this same page, so the
 * person lands where they were headed. The one-tap button exists only in demo mode.
 */
export function SignInGate({ demo, children }: { demo: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function tryDemo() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "caretaker" }),
      });
      if (!res.ok) {
        setError("Could not start the demo. Pick a name instead.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not start the demo. Pick a name instead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 grid gap-5">
      <div className="grid gap-2">{children}</div>
      <div className="card grid gap-4">
        {demo && (
          <div className="grid gap-2">
            <button type="button" className="btn-pop w-full" onClick={tryDemo} disabled={busy}>
              {busy ? "Starting" : "Try it now"}
            </button>
            <p className="small soft">Uses the demo caretaker account. Simulated, not a real sign-in.</p>
            {error && (
              <p role="alert" className="font-bold text-danger">
                {error}
              </p>
            )}
          </div>
        )}
        <SignIn username={null} inline />
      </div>
    </div>
  );
}
