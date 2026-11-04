import Link from "next/link";
import type { TimelineEntry } from "@/server/timeline";
import { niceDate } from "@/lib/niceDate";

/*
 * Who did it is told three ways, never by colour alone: the mark on the rail (a tick, AI or the peso sign),
 * the word under the title, and the screen-reader text. Done steps are filled; steps still ahead are plain.
 */
const WHO = { person: "A person", ai: "The Treasurer (AI)", paypal: "PayPal" } as const;
const MARK = {
  person: { text: "✓", cls: "bg-main text-white" },
  ai: { text: "AI", cls: "bg-ink text-white" },
  paypal: { text: "₱", cls: "bg-pop text-ink" },
} as const;

export function CatTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="grid gap-0">
      {entries.map((e, i) => {
        const mark = MARK[e.kind];
        return (
          <li key={`${e.at ?? "next"}-${i}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-in text-xs font-extrabold ${e.done ? mark.cls : "bg-pale"}`}
              >
                {e.done ? mark.text : ""}
              </span>
              {i < entries.length - 1 && <span aria-hidden="true" className="w-0.5 flex-1 bg-pale" />}
            </div>
            <div className="min-w-0 pb-4">
              <p className={e.done ? "font-bold" : "soft"}>
                {e.title}
                {!e.done && <span className="sr-only"> (not yet)</span>}
              </p>
              {e.done && (
                <p className="small soft">
                  {e.day && <span>{niceDate(e.day)}</span>}
                  {e.day && " "}
                  <span className={`font-bold ${e.day ? "ml-1" : ""}`}>{WHO[e.kind]}</span>
                </p>
              )}
              {e.detail &&
                (e.kind === "ai" ? (
                  <p className="mt-1.5 max-w-[52ch] rounded-in bg-bg px-3 py-2 text-[0.9375rem] leading-snug">
                    <span className="small mb-0.5 block font-bold soft">Treasurer</span>
                    {e.detail}
                  </p>
                ) : (
                  <p className="small soft">{e.detail}</p>
                ))}
              {e.ledger && (
                <Link href="/ledger" className="link small -mt-1">
                  See it on the Ledger
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
