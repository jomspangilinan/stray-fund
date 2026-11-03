import { StaffLocation } from "@/components/StaffLocation";
import type { ExactPlace } from "@/server/vetFlow";

/** Vet pages only. Exact coordinates never appear on a public page, and not in the demo, which shows the area instead. */
export function ExactLocation({ exact, area, exactHidden }: { exact: ExactPlace; area: string; exactHidden: boolean }) {
  return (
    <StaffLocation
      exact={exact}
      area={area}
      exactHidden={exactHidden}
      approxNote="Approximate. The finder shared no location, so this is the middle of the area."
      noneNote="No location on file. Ask a caretaker."
    />
  );
}
