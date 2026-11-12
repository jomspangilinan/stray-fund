"use client";

import { createContext, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ToneNote, type ReplyTone } from "./ToneNote";

export const DeskItemContext = createContext<{ done: (message: string) => void; hold: (message: string, tone: ReplyTone) => void } | null>(null);

const SHOWN_MS = 1600;

/**
 * One thing waiting on the desk. When an action inside it works, the card turns into the answer, stays long
 * enough to read, then the list refreshes and the item leaves. If it is still listed after that, it comes back.
 */
export function DeskItem({ label, anchor, children }: { label?: string; /** The id the swipe stack scrolls to for this item's full form. */ anchor?: string; children: React.ReactNode }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  // A warning or a failure stays until the person dismisses it, so it cannot be missed.
  const [held, setHeld] = useState<{ message: string; tone: ReplyTone } | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const wasRefreshing = useRef(false);

  useEffect(() => {
    if (message === null) return;
    const t = setTimeout(() => startRefresh(() => router.refresh()), SHOWN_MS);
    return () => clearTimeout(t);
  }, [message, router]);

  useEffect(() => {
    if (refreshing) wasRefreshing.current = true;
    else if (wasRefreshing.current) {
      wasRefreshing.current = false;
      // Still here after the refresh, so a note or similar: show the card again.
      setMessage(null);
    }
  }, [refreshing]);

  if (held) {
    return (
      <li id={anchor} className="card scroll-mt-4">
        <ToneNote tone={held.tone} message={held.message} />
        {label && <p className="small soft mt-2">{label}</p>}
        <button
          type="button"
          className="btn-quiet mt-3 w-full"
          onClick={() => {
            setHeld(null);
            router.refresh();
          }}
        >
          Dismiss
        </button>
      </li>
    );
  }
  if (message !== null) {
    return (
      <li id={anchor} className="card scroll-mt-4">
        <ToneNote tone="ok" message={message} />
        {label && <p className="small soft mt-2">{label}</p>}
      </li>
    );
  }
  return (
    <li id={anchor} className="card scroll-mt-4">
      <DeskItemContext.Provider value={{ done: setMessage, hold: (m, tone) => setHeld({ message: m, tone }) }}>{children}</DeskItemContext.Provider>
    </li>
  );
}
