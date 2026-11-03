import { ActionForm } from "../ActionForm";
import type { CaretakerQueue, SightingItem } from "@/server/caretaker/queue";
import { DeskItem } from "./DeskItem";
import { Section, Where } from "./DeskParts";
import { CatPicker, Hidden } from "./Fields";
import { STATUS_LABEL } from "@/server/public";

const SIGHTING_REASON: Record<string, string> = {
  possible_match: "The AI thinks this may be a cat we know, but was not sure enough.",
  ai_unusable: "The AI could not give a usable answer for this photo.",
};

function Assessment({ a }: { a: NonNullable<SightingItem["assessment"]> }) {
  return (
    <div className="note mt-2 small">
      <p className="font-bold">As read by the AI (may be wrong)</p>
      <p>Cat visible: {a.is_cat ? "yes" : "no"}, photo quality {a.cat_visible_quality}.</p>
      <p>
        Coat: {a.coat_pattern}, {a.colors.join(", ") || "no colours"}. {a.markings}
      </p>
      <p>Suggested name: {a.suggested_name}.</p>
      <p>Flags: {Object.entries(a.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}.</p>
      <p className="break-words">Bio: {a.short_bio}</p>
    </div>
  );
}

export function Sightings({ items, cats }: { items: SightingItem[]; cats: CaretakerQueue["catChoices"] }) {
  return (
    <Section id="sightings" count={items.length}>
      {items.map((s) => (
        <DeskItem key={s.id} label={`Photo from ${s.date}`}>
          <h3 className="text-base font-extrabold">Photo from {s.date}</h3>
          <p className="small">{(s.reason && SIGHTING_REASON[s.reason]) ?? "A caretaker needs to decide."}</p>
          {s.catName && <p className="small">Linked to: {s.catName}</p>}
          <Where exact={s.exact} area={s.area} exactHidden={s.exactHidden} />
          {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route */}
          <img src={`/api/caretaker/images/sighting/${s.id}`} alt="The original photo" className="mt-3 max-h-72 w-full rounded-in object-contain" />
          {s.assessment && <Assessment a={s.assessment} />}
          <ActionForm action="sighting_confirm_new" submitLabel="Confirm as a new cat">
            <Hidden name="sightingId" value={s.id} />
          </ActionForm>
          <ActionForm action="sighting_merge" submitLabel="Merge into this cat" quiet>
            <Hidden name="sightingId" value={s.id} />
            <CatPicker
              defaultValue={s.candidates[0]?.id ?? ""}
              suggested={s.candidates.map((c) => ({ id: c.id, label: c.name }))}
              options={cats
                .filter((c) => !s.candidates.some((x) => x.id === c.id))
                .map((c) => ({ id: c.id, label: `${c.name} (${STATUS_LABEL[c.status] ?? c.status})` }))}
            />
          </ActionForm>
          <ActionForm action="sighting_reject" submitLabel="Reject this photo" quiet>
            <Hidden name="sightingId" value={s.id} />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}
