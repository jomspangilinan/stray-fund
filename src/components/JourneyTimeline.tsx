import type { JourneyStep } from "@/server/public";

function niceDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
export { niceDate };

/** Done is shown by a filled marker and the word, never colour alone. */
export function JourneyTimeline({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="grid gap-0">
      {steps.map((s, i) => (
        <li key={s.step} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center border-2 border-ink text-xs font-bold ${s.done ? "bg-sampaguita text-paper" : "bg-paper"}`}
            >
              {s.done ? "✓" : ""}
            </span>
            {i < steps.length - 1 && <span aria-hidden="true" className="w-0.5 flex-1 bg-line" />}
          </div>
          <div className="pb-4">
            <p className={s.done ? "font-bold" : "text-dusk"}>
              {s.step}
              <span className="sr-only">{s.done ? " (done)" : " (not yet)"}</span>
            </p>
            {s.done && s.date && <p className="text-sm text-dusk">{niceDate(s.date)}</p>}
            {s.done && s.note && <p className="text-sm text-dusk">{s.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
