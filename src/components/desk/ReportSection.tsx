import { ActionForm } from "../ActionForm";
import type { ReportItem } from "@/server/caretaker/queue";
import { DeskItem } from "./DeskItem";
import { Section, Where } from "./DeskParts";
import { Hidden } from "./Fields";

const CLAIM_TITLE: Record<string, string> = { injured: "Hurt", pregnant: "Pregnant", sick: "Sick", kitten: "A kitten" };

/** Who is speaking. Only these two can be open; a caretaker's or vet's word is confirmed at once. */
const SAYS = (source: string) => (source === "photo" ? "The AI thinks this photo shows" : "Neighbour says");

function Card({ r }: { r: ReportItem }) {
  const title = CLAIM_TITLE[r.claim] ?? r.claim;
  return (
    <DeskItem label={`${title}, ${r.catName ?? "cat not sorted yet"}`}>
      <p className="small soft">{SAYS(r.source)}</p>
      <h3 className="text-xl font-extrabold">{title}</h3>
      <p className="small">{r.catName ? `About ${r.catName}` : "A cat we don't know yet"}</p>
      {r.sightingId && (
        // eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route
        <img src={`/api/caretaker/images/sighting/${r.sightingId}`} alt="The photo this report is about" className="mt-3 max-h-48 w-full rounded-in object-contain" />
      )}
      {r.note && <p className="note mt-2 break-words">{r.note}</p>}
      {r.photoAgrees !== null && <p className="small mt-2 font-bold">{r.photoAgrees ? "The photo seems to show this" : "The photo doesn't clearly show this"}</p>}
      {r.checkQuestion && <p className="note mt-2 break-words">The treasurer asks: {r.checkQuestion}</p>}
      <Where exact={r.exact} area={r.area} exactHidden={r.exactHidden} />
      {r.catId ? (
        <>
          {r.claim !== "kitten" && <p className="small soft mt-3">Confirming keeps the cat from funding until a vet clears it.</p>}
          <ActionForm action="report_confirm" submitLabel="Confirm">
            <Hidden name="reportId" value={r.id} />
          </ActionForm>
          <ActionForm action="report_dismiss" submitLabel="Dismiss" quiet>
            <Hidden name="reportId" value={r.id} />
          </ActionForm>
        </>
      ) : (
        <p className="mt-3 font-bold">Sort this photo below first.</p>
      )}
    </DeskItem>
  );
}

/** Reports come first on the desk, above payouts: a cat someone says is hurt waits for a person before anything else. */
export function Reports({ items }: { items: ReportItem[] }) {
  return (
    <Section id="reports" count={items.length}>
      {items.map((r) => (
        <Card key={r.id} r={r} />
      ))}
    </Section>
  );
}
