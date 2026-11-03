import { waitingSections } from "@/lib/deskSections";
import type { CaretakerQueue } from "@/server/caretaker/queue";

/** A short row that jumps to each section with something in it. Only worth showing when there is more than one. */
export function DeskJump({ queue }: { queue: CaretakerQueue }) {
  const waiting = waitingSections(queue);
  if (waiting.length < 2) return null;
  return (
    <nav aria-label="Jump to" className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {waiting.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="chip !min-h-11">
          {s.chip} {s.n}
        </a>
      ))}
    </nav>
  );
}
