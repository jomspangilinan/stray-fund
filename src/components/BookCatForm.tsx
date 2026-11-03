"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** A vet picks a day and takes a funded cat. The server decides whether they may. */
export function BookCatForm({ catId, catName, today }: { catId: string; catName: string; today: string }) {
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function book(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/vet/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catId, date }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        setError(body.error ?? "Could not make that booking. Try again.");
        return;
      }
      router.push(`/vet/bookings/${body.id}`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  const fieldId = `date-${catId}`;
  return (
    <form onSubmit={book} className="mt-4 grid gap-3">
      <div className="grid gap-1">
        <label htmlFor={fieldId} className="font-bold">
          Visit date
        </label>
        <input
          id={fieldId}
          type="date"
          className="field"
          min={today}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
          disabled={sending}
        />
      </div>
      <button type="submit" className="btn" disabled={sending}>
        {sending ? "Booking" : `Book ${catName}`}
      </button>
      {error && (
        <p role="alert" className="note note-bad font-bold">
          {error}
        </p>
      )}
    </form>
  );
}
