import { ActionForm } from "../ActionForm";
import type { CaretakerQueue } from "@/server/caretaker/queue";
import { DeskItem } from "./DeskItem";
import { Section, Where } from "./DeskParts";
import { Hidden } from "./Fields";
import { niceDate } from "@/lib/niceDate";

export function EarTips({ items }: { items: CaretakerQueue["earTipPending"] }) {
  return (
    <Section id="ears" count={items.length}>
      {items.map((c) => (
        <DeskItem key={c.id} label={c.name}>
          <h3 className="text-base font-extrabold">{c.name}</h3>
          <p className="small">
            Neighbours so far: {c.yes} said ear-tipped, {c.no} said not.
          </p>
          <Where exact={c.exact} area={c.area} exactHidden={c.exactHidden} />
          <ActionForm action="cat_set_ear_tip" submitLabel="Ear is tipped, already neutered" quiet>
            <Hidden name="catId" value={c.id} />
            <Hidden name="earTip" value="present" />
          </ActionForm>
          <ActionForm action="cat_set_ear_tip" submitLabel="Ear is not tipped, join the queue" quiet>
            <Hidden name="catId" value={c.id} />
            <Hidden name="earTip" value="absent" />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}

export function NeuteredWithoutRecord({ items }: { items: CaretakerQueue["neuteredWithoutRecord"] }) {
  return (
    <Section id="neutered" count={items.length}>
      {items.map((c) => (
        <DeskItem key={c.id} label={c.name}>
          <h3 className="text-base font-extrabold">{c.name}</h3>
          <p className="small">Marked neutered without a vet. No money is set aside for this cat.</p>
          <ActionForm action="cat_undo_neutered" submitLabel="Not neutered, back to the queue" quiet>
            <Hidden name="catId" value={c.id} />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}

/** The one place names are decided. A caretaker who wants to type a name opens the cat's card and uses the pencil. */
export function NameSuggestions({ items }: { items: CaretakerQueue["nameSuggestions"] }) {
  return (
    <Section id="names" count={items.length}>
      {items.map((n) => (
        <DeskItem key={n.id}>
          {n.photoSightingId && (
            // eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route
            <img src={`/api/caretaker/images/sighting/${n.photoSightingId}`} alt={`${n.catName}`} className="max-h-56 w-full rounded-in object-contain" />
          )}
          <p className="small soft mt-3">Now called {n.catName}</p>
          <h3 className="text-base font-extrabold break-words">{n.name}</h3>
          <ActionForm action="name_approve" submitLabel="Approve">
            <Hidden name="suggestionId" value={n.id} />
          </ActionForm>
          <ActionForm action="name_dismiss" submitLabel="Dismiss" quiet>
            <Hidden name="suggestionId" value={n.id} />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}

export function HeldPhotos({ items }: { items: CaretakerQueue["heldPhotos"] }) {
  return (
    <Section id="photos" count={items.length}>
      {items.map((p) => (
        <DeskItem key={p.sightingId} label={p.catName ?? "No cat yet"}>
          <h3 className="text-base font-extrabold">{p.catName ?? "No cat yet"}</h3>
          <p className="small">Taken {niceDate(p.date)}. Not shown publicly.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route */}
          <img src={`/api/caretaker/images/sighting/${p.sightingId}`} alt="The original photo" className="mt-3 max-h-72 w-full rounded-in object-contain" />
          <ActionForm action="photo_publish" submitLabel="Publish with areas blurred">
            <Hidden name="sightingId" value={p.sightingId} />
            {p.hasRegions && <p className="small">The AI marked areas to blur. They will be blurred.</p>}
            {p.needsTick && (
              <label className="flex items-start gap-3">
                <input type="checkbox" name="noSensitive" value="on" className="mt-1 h-5 w-5" />
                <span>{p.hasRegions ? "No other house numbers, signs or plates visible" : "No house numbers, signs or plates visible"}</span>
              </label>
            )}
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}
