import { StaffLocation } from "@/components/StaffLocation";
import { deskTitle, type DeskSectionId } from "@/lib/deskSections";
import type { ExactSpot } from "@/server/caretaker/queue";

export function Where({ exact, area, exactHidden }: { exact: ExactSpot; area: string; exactHidden: boolean }) {
  return <StaffLocation exact={exact} area={area} exactHidden={exactHidden} />;
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
