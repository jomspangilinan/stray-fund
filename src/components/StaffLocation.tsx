import { mapLink, type MapSpot } from "@/lib/mapLink";

/** Staff screens only (desk and vet). Public pages never get an exact location or a link built from one. */
export function StaffLocation({
  exact,
  area,
  exactHidden,
  approxNote = "Approximate: the middle of the area.",
  noneNote = "No location on file.",
}: {
  exact: MapSpot;
  area: string;
  exactHidden: boolean;
  approxNote?: string;
  noneNote?: string;
}) {
  const link = mapLink({ exact, area, exactHidden });
  if (!link) return <p className="small soft">{noneNote}</p>;
  return (
    <div className="grid gap-1">
      <a href={link.href} target="_blank" rel="noopener noreferrer" className="btn-quiet w-full justify-start sm:w-auto">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          {exact && !exact.approximate ? <path d="M3 11l18-8-8 18-2-8-8-2z" /> : <><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></>}
        </svg>
        {link.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      {exactHidden ? (
        <p className="small"><span className="font-bold">Area:</span> {area}. <span className="soft">Exact spots are hidden in the demo.</span></p>
      ) : (
        exact && (
          <p className="small soft">
            <span className="tabular-nums select-all">{exact.lat.toFixed(5)}, {exact.lng.toFixed(5)}</span>
            {exact.approximate && <span className="block">{approxNote}</span>}
          </p>
        )
      )}
    </div>
  );
}
