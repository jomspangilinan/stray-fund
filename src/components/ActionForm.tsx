"use client";

import { createContext, useContext, useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SendGate } from "@/lib/sendGate";
import { DeskItemContext } from "./desk/DeskItem";
import { ToneNote, type ReplyTone } from "./desk/ToneNote";

type Reply = { ok?: boolean; message?: string; tone?: ReplyTone };
type Body = Record<string, string | string[]>;

/** The problems found before anything is sent, by field name. A field shows its own under itself. */
export const FormErrors = createContext<Record<string, string>>({});
export const useFieldError = (name: string): string | undefined => useContext(FormErrors)[name];

/**
 * One caretaker action. The inputs inside are plain fields; names ending in [] collect into a list.
 * A missing required field is named under that field. With `confirm`, the first tap asks once in place
 * and only Send moves on. The server checks the role and the rules again. Inside a DeskItem the answer
 * replaces the item and the item leaves the list; elsewhere it shows under the button.
 */
export function ActionForm({
  action,
  submitLabel,
  quiet = false,
  confirm,
  children,
}: {
  action: string;
  submitLabel: string;
  quiet?: boolean;
  confirm?: { question: string; send: string };
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const item = useContext(DeskItemContext);
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reply, setReply] = useState<{ tone: ReplyTone; message: string } | null>(null);
  const asked = useRef<HTMLDivElement>(null);
  // The gate holds the confirm step and the one-send lock; it posts through the latest send below.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [gate] = useState(() => new SendGate<Body>(Boolean(confirm), async () => {}, redraw));
  const asking = gate.asking;

  useEffect(() => {
    if (asking) asked.current?.focus();
  }, [asking]);

  function collect(form: HTMLFormElement): Body {
    const data = new FormData(form);
    const body: Body = {};
    for (const key of new Set(data.keys())) {
      const values = data.getAll(key).filter((v): v is string => typeof v === "string");
      if (key.endsWith("[]")) body[key.slice(0, -2)] = values;
      else body[key] = values[0] ?? "";
    }
    return body;
  }

  function missing(form: HTMLFormElement): Record<string, string> {
    const found: Record<string, string> = {};
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
      if (!el.required || !el.name || found[el.name]) continue;
      const empty = el instanceof HTMLInputElement && el.type === "checkbox" ? !el.checked : el.value.trim() === "";
      if (empty) found[el.name] = el.dataset.missing ?? "Fill this in.";
    }
    return found;
  }

  async function send(body: Body) {
    setSending(true);
    setReply(null);
    try {
      const res = await fetch(`/api/caretaker/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Reply;
      const worked = res.ok && json.ok === true;
      const tone: ReplyTone = worked ? (json.tone ?? "ok") : "bad";
      const message = json.message ?? "Something went wrong. Try again.";
      if (item && tone === "ok") item.done(message);
      else if (item && worked) item.hold(message, tone);
      else {
        setReply({ tone, message });
        if (res.ok) router.refresh();
      }
    } catch {
      setReply({ tone: "bad", message: "Could not reach the server. Check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    gate.setPost(send);
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending || asking) return;
    const form = e.currentTarget;
    const found = missing(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = Array.from(form.elements).find((el) => (el as HTMLInputElement).name in found) as HTMLElement | undefined;
      first?.focus();
      return;
    }
    void gate.submit(collect(form));
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      onInput={(e) => {
        const name = (e.target as HTMLInputElement).name;
        if (name && errors[name]) setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name)));
      }}
      className="mt-3 grid gap-3"
    >
      <FormErrors.Provider value={errors}>{children}</FormErrors.Provider>
      {asking && confirm ? (
        <div ref={asked} tabIndex={-1} role="group" aria-label="Check before sending" className="note grid gap-3 outline-none">
          <p className="font-bold">{confirm.question}</p>
          <div className="flex gap-3">
            <button type="button" className="btn flex-1" disabled={sending} onClick={() => void gate.confirm()}>
              {sending ? "Working" : confirm.send}
            </button>
            <button type="button" className="btn-quiet flex-1" disabled={sending} onClick={() => gate.back()}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <button type="submit" className={quiet ? "btn-quiet" : "btn"} disabled={sending}>
          {sending ? "Working" : submitLabel}
        </button>
      )}
      {reply && <ToneNote tone={reply.tone} message={reply.message} />}
      {reply && reply.tone !== "ok" && (
        <button type="button" className="btn-quiet w-full" onClick={() => setReply(null)}>
          Dismiss
        </button>
      )}
    </form>
  );
}
