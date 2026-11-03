import { ActionForm } from "../ActionForm";
import { formatPeso } from "@/lib/money";
import type { ReceiptItem } from "@/server/caretaker/queue";
import { DeskItem } from "./DeskItem";
import { Section } from "./DeskParts";
import { Field, Hidden } from "./Fields";

function Reading({ r }: { r: ReceiptItem }) {
  const p = r.parsed;
  return (
    <div className="note mt-2 small">
      <p className="font-bold">As read by the AI (may be wrong)</p>
      {p ? (
        <>
          <p className="break-words">Clinic: {p.clinic ?? "unreadable"}</p>
          <p>Date: {p.date ?? "unreadable"}</p>
          <p>Total: {p.total_centavos === null ? "unreadable" : formatPeso(p.total_centavos)}</p>
          <p className="break-words">Currency: {p.currency ?? "unreadable"}. Receipt number: {p.receipt_number ?? "unreadable"}.</p>
          <p className="break-words">Cat name: {p.cat_name ?? "none"}</p>
          <p className="break-words">Items: {p.items.join("; ") || "none"}</p>
          {p.tamper_signs.length > 0 && <p className="break-words">Signs of editing: {p.tamper_signs.join("; ")}</p>}
        </>
      ) : (
        <p>Nothing could be read from the receipt.</p>
      )}
    </div>
  );
}

export function Receipts({ items }: { items: ReceiptItem[] }) {
  return (
    <Section id="receipts" count={items.length}>
      {items.map((r) => {
        const prefill = r.parsed?.total_centavos != null && r.parsed.total_centavos > 0 ? String(Math.round(r.parsed.total_centavos / 100)) : "";
        return (
          <DeskItem key={r.id} label={r.catName}>
            <h3 className="text-base font-extrabold">{r.catName}</h3>
            <p className="small">
              Vet {r.vetName}, clinic on account: {r.clinicName ?? "none"}. Sent {r.date}.
            </p>
            <p className="small">
              Package {formatPeso(r.packagePrice)}, deposit paid {formatPeso(r.depositPaid)}.
            </p>
            {r.reasonMessages.length > 0 && (
              <ul className="mt-2 list-disc pl-5 small">
                {r.reasonMessages.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- private evidence behind a signed-in route */}
              <img src={`/api/caretaker/images/receipt/${r.id}`} alt="The original receipt" className="max-h-72 w-full rounded-in object-contain" />
              {/* eslint-disable-next-line @next/next/no-img-element -- private evidence behind a signed-in route */}
              <img src={`/api/caretaker/images/eartip/${r.id}`} alt="The ear-tip photo" className="max-h-72 w-full rounded-in object-contain" />
            </div>
            <Reading r={r} />
            <ActionForm action="evidence_accept" submitLabel="Accept this evidence">
              <Hidden name="receiptId" value={r.id} />
              <Field
                label="Receipt total, in pesos"
                name="total"
                defaultValue={prefill}
                missing="Type the total on the receipt."
                hint={`Whole pesos or with centavos. More than ${formatPeso(r.depositPaid)} and at most ${formatPeso(r.packagePrice)}. Prefilled from the AI's reading, so check it against the image.`}
              />
              <label className="flex items-start gap-3">
                <input type="checkbox" name="earTipConfirmed" value="on" className="mt-1 h-5 w-5" />
                <span>I confirmed the ear-tip in the photo</span>
              </label>
              <Field label="Note: what you checked" name="note" missing="Say what you checked." />
            </ActionForm>
            <ActionForm action="evidence_reject" submitLabel="Do not accept" quiet>
              <Hidden name="receiptId" value={r.id} />
              <Field label="Note: why" name="note" missing="Say why." />
            </ActionForm>
          </DeskItem>
        );
      })}
    </Section>
  );
}

export function EarTipPhotos({ items }: { items: ReceiptItem[] }) {
  return (
    <Section id="eartip-photos" count={items.length}>
      {items.map((r) => (
        <DeskItem key={r.id} label={r.catName}>
          <h3 className="text-base font-extrabold">{r.catName}</h3>
          <p className="small">
            Vet {r.vetName}. Sent {r.date}. The receipt passed every check. Package {formatPeso(r.packagePrice)}, deposit paid {formatPeso(r.depositPaid)}.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- private evidence behind a signed-in route */}
            <img src={`/api/caretaker/images/eartip/${r.id}`} alt="The vet's photo of the cat after surgery" className="max-h-72 w-full rounded-in object-contain" />
            {/* eslint-disable-next-line @next/next/no-img-element -- private evidence behind a signed-in route */}
            <img src={`/api/caretaker/images/receipt/${r.id}`} alt="The original receipt" className="max-h-72 w-full rounded-in object-contain" />
          </div>
          <Reading r={r} />
          <ActionForm action="evidence_confirm_ear_tip" submitLabel="I saw the ear-tip in the photo">
            <Hidden name="receiptId" value={r.id} />
          </ActionForm>
          <ActionForm action="evidence_reject" submitLabel="Do not accept" quiet>
            <Hidden name="receiptId" value={r.id} />
            <Field label="Note: why" name="note" missing="Say why." />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}
