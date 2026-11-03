export type EarTipAnswer = "yes" | "no" | "unsure";

const OPTIONS: { value: EarTipAnswer; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unsure", label: "Not sure" },
];

/** Two small plain ears. A tipped ear has its point cut straight across. */
function EarDrawing() {
  return (
    <svg viewBox="0 0 96 44" width="96" height="44" role="img" aria-label="Left, a tipped ear with a flat top. Right, an ear with a point." className="flex-none">
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
        <path d="M10 40 L18 12 L36 12 L44 40 Z" />
        <path d="M56 40 L74 6 L92 40 Z" />
      </g>
    </svg>
  );
}

/**
 * Yes, No or Not sure about the ear tip. Controlled by the parent: the Spot flow keeps the choice until the
 * photo is sent, the cat card sends it at once. The hint says what a tip is, in one line.
 */
export function EarTipChoice({
  value,
  onChange,
  disabled,
  legend = "Ear-tip?",
}: {
  value: EarTipAnswer;
  onChange: (v: EarTipAnswer) => void;
  disabled?: boolean;
  legend?: string;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-bold">{legend}</legend>
      <div className="flex items-center gap-3">
        <EarDrawing />
        <p className="small soft">A tip is a straight cut across the point of one ear.</p>
      </div>
      <div role="radiogroup" aria-label="Ear-tip" className="flex flex-wrap gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={disabled}
            className="chip"
            onClick={() => onChange(o.value)}
          >
            {value === o.value ? "✓ " : ""}
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
