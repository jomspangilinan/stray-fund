"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { feedHeadline, feedStory } from "@/lib/feedCopy";
import { formatPeso } from "@/lib/money";
import type { PublicAgentAction } from "@/server/public";
import { niceDate } from "@/lib/niceDate";

const POLL_MS = 5_000;

/** Takes only serialized public data, then refreshes it. A failed poll keeps what is on screen, and says so. */
export function AgentFeed({ initial }: { initial: PublicAgentAction[] }) {
  const [actions, setActions] = useState(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/agent/feed", { cache: "no-store" });
        if (!res.ok) throw new Error("feed");
        const body = (await res.json()) as { actions: PublicAgentAction[] };
        if (live) {
          setActions(body.actions);
          setStale(false);
        }
      } catch {
        if (live) setStale(true);
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      {stale && (
        <p role="status" className="note note-bad mt-5 font-bold">
          Could not refresh the decisions. What you see may be out of date, and we will keep trying.
        </p>
      )}
      {actions.length === 0 ? (
        <div className="card mt-5">
          <p className="font-bold">Nothing yet.</p>
          <p className="mt-1 soft">The AI treasurer posts here as soon as money moves.</p>
        </div>
      ) : (
        <ul aria-live="polite" className="mt-5 grid gap-3">
          {actions.map((a) => {
            const story = feedStory(a);
            return (
            <li key={a.id} id={`a-${a.id}`} className="card scroll-mt-4">
              <div className="flex items-baseline justify-between gap-x-4">
                <h2 className="h2 min-w-0">{feedHeadline(a)}</h2>
                {a.amount !== null && <p className="flex-none text-lg font-extrabold tabular-nums">{formatPeso(a.amount)}</p>}
              </div>
              <p className="mt-2">{a.reason}</p>
              {story && (
                <ol className="small mt-3 grid gap-1 border-l-4 border-pale pl-3">
                  <li>{story.ai}</li>
                  {story.person && <li className="font-bold">{story.person}</li>}
                </ol>
              )}
              <p className="small soft mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                {a.action === "Funded a cat" && <span className="tag">AI pick</span>}
                <span className={`tag ${a.refused ? "tag-bad" : ""}`}>{a.status}</span>
                <span>{niceDate(a.date)}</span>
                {a.paypalRef && (
                  <>
                    <span className="break-all">PayPal {a.paypalRef}</span>
                    <Link href={`/ledger?q=${encodeURIComponent(a.paypalRef)}`} className="font-bold text-main underline underline-offset-4">
                      See it in the Ledger
                    </Link>
                  </>
                )}
              </p>
            </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
