import { deskTitle, type DeskSectionId } from "@/lib/deskSections";
import type { ExactSpot } from "@/server/caretaker/queue";

export function Where({ exact, area, exactHidden }: { exact: ExactSpot; area: string; exactHidden: boolean }) {
  if (exactHidden) return <p className="small"><span className="font-bold">Area:</span> {area}. <span className="soft">Exact spots are hidden in the demo.</span></p>;
  if (!exact) return <p className="small soft">No location on file.</p>;
  return (
    <p className="small">
      <span className="font-bold">Exact location:</span> {exact.lat.toFixed(5)}, {exact.lng.toFixed(5)}
      {exact.approximate && <span className="block soft">Approximate: the middle of the colony.</span>}
    </p>
  );
}

/** A section of "To check". It is only drawn when it has items, so there is no empty state here. */
export function Section({ id, count, children }: { id: DeskSectionId; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="mt-10 scroll-mt-4" aria-labelledby={id}>
      <h2 id={id} className="h2">
        {deskTitle(id)} <span className="soft">({count})</span>
      </h2>
      <ul className="mt-4 grid gap-3">{children}</ul>
    </section>
  );
}
