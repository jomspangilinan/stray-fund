import { SCAN_STEPS, scanProgress } from "@/lib/scanSteps";

/** The generic progress list. It takes time only, never a result, so it cannot show a finding. */
export function ScanChecklist({ elapsedMs, responded }: { elapsedMs: number; responded: boolean }) {
  const { done, active } = scanProgress(elapsedMs, responded);
  return (
    <ol className="scan-list" aria-label="Checking the photo">
      {SCAN_STEPS.map((label, i) => {
        const isDone = i < done;
        const isActive = i === active;
        return (
          <li
            key={label}
            data-done={isDone ? "true" : undefined}
            data-active={isActive ? "true" : undefined}
            className="scan-step"
          >
            <span className="scan-mark" aria-hidden="true">
              {isDone ? (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              ) : isActive ? (
                <i className="scan-dot" />
              ) : null}
            </span>
            <span>{label}</span>
            <span className="sr-only">{isDone ? ", done" : isActive ? ", working" : ", waiting"}</span>
          </li>
        );
      })}
    </ol>
  );
}
