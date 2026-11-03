import { ActionForm } from "../ActionForm";
import type { CaretakerQueue } from "@/server/caretaker/queue";
import { DeskItem } from "./DeskItem";
import { Section } from "./DeskParts";
import { Field, Hidden } from "./Fields";

export function Reviews({ items }: { items: CaretakerQueue["reviews"] }) {
  return (
    <Section id="reviews" count={items.length}>
      {items.map((r) => (
        <DeskItem key={r.id} label={r.subject}>
          <h3 className="text-base font-extrabold break-words">{r.subject}</h3>
          <p className="small break-words">{r.reason}</p>
          <p className="small soft">Asked {r.date}</p>
          <ActionForm action="review_resolve" submitLabel="Close this question">
            <Hidden name="reviewId" value={r.id} />
            <Field label="Note: what you decided or did" name="resolution" missing="Say what you decided or did." />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}

export function Wakeups({ items }: { items: CaretakerQueue["failedWakeups"] }) {
  return (
    <Section id="wakeups" count={items.length}>
      {items.map((w) => (
        <DeskItem key={w.id} label={w.kind}>
          <h3 className="text-base font-extrabold">{w.kind}</h3>
          <p className="small">
            Failed after {w.attempts} tries, queued {w.date}.
          </p>
          <ActionForm action="wakeup_retry" submitLabel="Try again">
            <Hidden name="wakeupId" value={w.id} />
          </ActionForm>
          <ActionForm action="wakeup_dismiss" submitLabel="Dismiss" quiet>
            <Hidden name="wakeupId" value={w.id} />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}
