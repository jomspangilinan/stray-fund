"use client";

import { useEffect, useState } from "react";
import { formatPeso } from "@/lib/money";
import type { PublicAgentAction } from "@/server/public";

const POLL_MS = 5_000;

/** Takes only serialized public data, then refreshes it. A failed poll keeps what is on screen. */
export function AgentFeed({ initial }: { initial: PublicAgentAction[] }) {
  const [actions, setActions] = useState(initial);

  useEffect(() => {
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/agent/feed", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { actions: PublicAgentAction[] };
        if (live) setActions(body.actions);
      } catch {
        // The next poll tries again.
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (actions.length === 0) {
    return <p className="note mt-8">Nothing yet. The treasurer posts here as soon as money moves.</p>;
  }
  return (
    <ul aria-live="polite" className="mt-8 flex flex-col gap-5">
      {actions.map((a) => (
        <li key={a.id} className="ticket">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <h2 className="text-2xl font-extrabold">{a.cat ? `${a.action}: ${a.cat}` : a.action}</h2>
            {a.amount !== null && <p className="font-display text-2xl font-extrabold">{formatPeso(a.amount)}</p>}
          </div>
          <p className="mt-3">{a.reason}</p>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-dusk">
            <span
              className={`border-2 border-ink px-2 font-bold text-ink ${a.refused ? "bg-paper" : "bg-sign"}`}
            >
              {a.status}
            </span>
            <span>{a.date}</span>
            {a.paypalRef && <span className="break-all">PayPal {a.paypalRef}</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}
