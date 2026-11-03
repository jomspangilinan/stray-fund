"use client";

/** Shown when a page fails to load. Names what happened and the one way forward. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="pt-8">
      <div className="card" role="alert">
        <h1 className="title">This page did not load</h1>
        <p className="mt-2 soft">Something went wrong on our side. Nothing you did caused it, and no money moved.</p>
        <button type="button" className="btn mt-4" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
