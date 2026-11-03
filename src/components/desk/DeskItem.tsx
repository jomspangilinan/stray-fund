"use client";

import { createContext, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export const DeskItemContext = createContext<{ done: (message: string) => void } | null>(null);

const SHOWN_MS = 1600;

/**
 * One thing waiting on the desk. When an action inside it works, the card turns into the answer, stays long
 * enough to read, then the list refreshes and the item leaves. If it is still listed after that, it comes back.
 */
export function DeskItem({ label, children }: { label?: string; children: React.ReactNode }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
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

  if (message !== null) {
    return (
      <li className="card">
        <p role="status" className="note note-ok font-bold">
          {message}
        </p>
        {label && <p className="small soft mt-2">{label}</p>}
      </li>
    );
  }
  return (
    <li className="card">
      <DeskItemContext.Provider value={{ done: setMessage }}>{children}</DeskItemContext.Provider>
    </li>
  );
}
