import type { ExactPlace } from "@/server/vetFlow";

/** Vet pages only. Exact coordinates never appear on a public page, and not in the demo, which shows the area instead. */
export function ExactLocation({ exact, area, exactHidden }: { exact: ExactPlace; area: string; exactHidden: boolean }) {
  if (exactHidden) return <p className="small"><span className="font-bold">Area:</span> {area}. <span className="soft">Exact spots are hidden in the demo.</span></p>;
  if (!exact) return <p className="small soft">No location on file. Ask a caretaker.</p>;
  return (
    <p className="small">
      <span className="font-bold">Exact location:</span> {exact.lat.toFixed(5)}, {exact.lng.toFixed(5)}
      {exact.approximate && <span className="block soft">Approximate. The finder shared no location, so this is the middle of the colony.</span>}
    </p>
  );
}
