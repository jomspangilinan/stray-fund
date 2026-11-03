"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Reply = { ok?: boolean; message?: string };

/**
 * One caretaker action. The inputs inside are plain fields; names ending in [] collect into a list.
 * The server checks the role and the rules again, and the answer is shown as it comes back.
 */
export function ActionForm({
  action,
  submitLabel,
  quiet = false,
  children,
}: {
  action: string;
  submitLabel: string;
  quiet?: boolean;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<{ ok: boolean; message: string } | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending) return;
    const data = new FormData(e.currentTarget);
    const body: Record<string, string | string[]> = {};
    for (const key of new Set(data.keys())) {
      const values = data.getAll(key).filter((v): v is string => typeof v === "string");
      if (key.endsWith("[]")) body[key.slice(0, -2)] = values;
      else body[key] = values[0] ?? "";
    }
    setSending(true);
    setReply(null);
    try {
      const res = await fetch(`/api/caretaker/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Reply;
      setReply({ ok: res.ok && json.ok === true, message: json.message ?? "Something went wrong. Try again." });
      if (res.ok) router.refresh();
    } catch {
      setReply({ ok: false, message: "Could not reach the server. Check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 grid gap-3">
      {children}
      <button type="submit" className={quiet ? "btn-quiet" : "btn"} disabled={sending}>
        {sending ? "Working" : submitLabel}
      </button>
      {reply && (
        <p role={reply.ok ? "status" : "alert"} className={`note font-bold ${reply.ok ? "note-ok" : "note-bad"}`}>
          {reply.message}
        </p>
      )}
    </form>
  );
}
