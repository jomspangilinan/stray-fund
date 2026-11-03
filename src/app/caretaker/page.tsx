import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionForm } from "@/components/ActionForm";
import { ListSkeleton } from "@/components/Loading";
import { PageHead } from "@/components/PageHead";
import { formatPeso } from "@/lib/money";
import {
  getCaretakerQueue,
  getRulesView,
  type CaretakerQueue,
  type ExactSpot,
  type PayoutItem,
  type ReceiptItem,
  type RulesView,
  type SightingItem,
} from "@/server/caretaker/queue";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "Caretaker | Stray Fund" };

const KIND: Record<string, string> = { deposit: "Deposit", balance: "Balance" };
const SIGHTING_REASON: Record<string, string> = {
  possible_match: "The AI thinks this may be a cat we know, but was not sure enough.",
  ai_unusable: "The AI could not give a usable answer for this photo.",
};

function Where({ exact }: { exact: ExactSpot }) {
  if (!exact) return <p className="small soft">No location on file.</p>;
  return (
    <p className="small">
      <span className="font-bold">Exact location:</span> {exact.lat.toFixed(5)}, {exact.lng.toFixed(5)}
      {exact.approximate && <span className="block soft">Approximate: the middle of the colony.</span>}
    </p>
  );
}

function Section({ id, title, count, empty, children }: { id: string; title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section className="mt-10" aria-labelledby={id}>
      <h2 id={id} className="h2">
        {title} <span className="soft">({count})</span>
      </h2>
      {count === 0 ? <p className="mt-3 soft">{empty}</p> : <ul className="mt-4 grid gap-3">{children}</ul>}
    </section>
  );
}

function Field({ label, name, type = "text", defaultValue, required = true, hint }: { label: string; name: string; type?: string; defaultValue?: string | number; required?: boolean; hint?: string }) {
  return (
    <label className="grid gap-1">
      <span className="font-bold">{label}</span>
      {hint && <span className="small soft">{hint}</span>}
      <input name={name} type={type} defaultValue={defaultValue} required={required} className="field" autoComplete="off" />
    </label>
  );
}

function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

function PayoutFacts({ p }: { p: PayoutItem }) {
  return (
    <>
      <h3 className="text-base font-extrabold">
        {formatPeso(p.amount)} to {p.vetName}
      </h3>
      <p className="small">
        {KIND[p.kind] ?? p.kind} for {p.catName}, {p.date}. Attempts: {p.attempts}.
      </p>
      {p.batchId && <p className="small break-all soft">PayPal batch: {p.batchId}</p>}
      {p.agentReason && <p className="mt-2 small soft">The treasurer wrote: {p.agentReason}</p>}
    </>
  );
}

function Approvals({ items }: { items: PayoutItem[] }) {
  return (
    <Section id="approvals" title="Payouts awaiting approval" count={items.length} empty="Nothing is waiting for your approval.">
      {items.map((p) => (
        <li key={p.id} className="card">
          <PayoutFacts p={p} />
          <ActionForm action="payout_approve" submitLabel="Approve and send">
            <Hidden name="payoutId" value={p.id} />
          </ActionForm>
          <ActionForm action="payout_reject" submitLabel="Reject" quiet>
            <Hidden name="payoutId" value={p.id} />
            <Field label="Reason" name="reason" />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

function NeedsReview({ items }: { items: PayoutItem[] }) {
  return (
    <Section id="payout-review" title="Payouts under review" count={items.length} empty="No payout needs a ruling.">
      {items.map((p) => (
        <li key={p.id} className="card">
          <PayoutFacts p={p} />
          {p.lastGatewayError && (
            <p className="note note-bad mt-2 small break-words">Last gateway error: {p.lastGatewayError}</p>
          )}
          <p className="mt-2 small">Check PayPal activity first. Money may have left even if this shows an error.</p>
          <ActionForm action="payout_resolve" submitLabel="It was paid">
            <Hidden name="payoutId" value={p.id} />
            <Hidden name="outcome" value="paid" />
            <Field label="PayPal reference" name="paypalRef" />
          </ActionForm>
          <ActionForm action="payout_resolve" submitLabel="It was not paid" quiet>
            <Hidden name="payoutId" value={p.id} />
            <Hidden name="outcome" value="not_paid" />
            <Field label="Note: what you checked" name="note" />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

function LongSent({ items }: { items: PayoutItem[] }) {
  return (
    <Section id="long-sent" title="Sent, but not confirmed for over an hour" count={items.length} empty="Every sent payout has been confirmed, or was sent within the hour.">
      {items.map((p) => (
        <li key={p.id} className="card">
          <PayoutFacts p={p} />
          <p className="note mt-2 small">
            Warning: PayPal has not confirmed this yet. If the vet&apos;s PayPal email has no account, the money stays
            unclaimed. Ask the vet to check, then leave a note. Nothing else can be done here.
          </p>
          <ActionForm action="payout_note" submitLabel="Save note" quiet>
            <Hidden name="payoutId" value={p.id} />
            <Field label="Note" name="note" />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

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

function Sightings({ items, cats }: { items: SightingItem[]; cats: CaretakerQueue["catChoices"] }) {
  return (
    <Section id="sightings" title="Sighting reviews" count={items.length} empty="No photo is waiting for a decision.">
      {items.map((s) => (
        <li key={s.id} className="card">
          <h3 className="text-base font-extrabold">Photo from {s.date}</h3>
          <p className="small">{(s.reason && SIGHTING_REASON[s.reason]) ?? "A caretaker needs to decide."}</p>
          {s.catName && <p className="small">Linked to: {s.catName}</p>}
          <Where exact={s.exact} />
          {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route */}
          <img src={`/api/caretaker/images/sighting/${s.id}`} alt="The original photo" className="mt-3 max-h-72 w-full rounded-in object-contain" />
          {s.assessment && <Assessment a={s.assessment} />}
          <ActionForm action="sighting_confirm_new" submitLabel="Confirm as a new cat">
            <Hidden name="sightingId" value={s.id} />
          </ActionForm>
          <ActionForm action="sighting_merge" submitLabel="Merge into this cat" quiet>
            <Hidden name="sightingId" value={s.id} />
            <label className="grid gap-1">
              <span className="font-bold">Cat</span>
              <select name="catId" className="field" required defaultValue={s.candidates[0]?.id ?? ""}>
                <option value="" disabled>
                  Choose a cat
                </option>
                {s.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    Suggested: {c.name}
                  </option>
                ))}
                {cats
                  .filter((c) => !s.candidates.some((x) => x.id === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.status})
                    </option>
                  ))}
              </select>
            </label>
          </ActionForm>
          <ActionForm action="sighting_reject" submitLabel="Reject this photo" quiet>
            <Hidden name="sightingId" value={s.id} />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

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

function Receipts({ items }: { items: ReceiptItem[] }) {
  return (
    <Section id="receipts" title="Receipt reviews" count={items.length} empty="No receipt is waiting for a decision.">
      {items.map((r) => {
        const prefill = r.parsed?.total_centavos != null && r.parsed.total_centavos > 0 ? String(Math.round(r.parsed.total_centavos / 100)) : "";
        return (
          <li key={r.id} className="card">
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
                hint={`Whole pesos or with centavos. More than ${formatPeso(r.depositPaid)} and at most ${formatPeso(r.packagePrice)}. Prefilled from the AI's reading, so check it against the image.`}
              />
              <label className="flex items-start gap-3">
                <input type="checkbox" name="earTipConfirmed" value="on" className="mt-1 h-5 w-5" />
                <span>I confirmed the ear-tip in the photo</span>
              </label>
              <Field label="Note: what you checked" name="note" />
            </ActionForm>
            <ActionForm action="evidence_reject" submitLabel="Do not accept" quiet>
              <Hidden name="receiptId" value={r.id} />
              <Field label="Note: why" name="note" />
            </ActionForm>
          </li>
        );
      })}
    </Section>
  );
}

function EarTipConfirmations({ items }: { items: ReceiptItem[] }) {
  return (
    <Section
      id="eartip-photos"
      title="Ear-tip photos to look at"
      count={items.length}
      empty="No vet photo is waiting for you."
    >
      {items.map((r) => (
        <li key={r.id} className="card">
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
            <Field label="Note: why" name="note" />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

function Reviews({ items }: { items: CaretakerQueue["reviews"] }) {
  return (
    <Section id="reviews" title="Questions from the treasurer" count={items.length} empty="The treasurer has no open questions.">
      {items.map((r) => (
        <li key={r.id} className="card">
          <h3 className="text-base font-extrabold break-words">{r.subject}</h3>
          <p className="small break-words">{r.reason}</p>
          <p className="small soft">Asked {r.date}</p>
          <ActionForm action="review_resolve" submitLabel="Close this question">
            <Hidden name="reviewId" value={r.id} />
            <Field label="Note: what you decided or did" name="resolution" />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

function Wakeups({ items }: { items: CaretakerQueue["failedWakeups"] }) {
  return (
    <Section id="wakeups" title="Jobs the treasurer gave up on" count={items.length} empty="No job has failed.">
      {items.map((w) => (
        <li key={w.id} className="card">
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
        </li>
      ))}
    </Section>
  );
}

function Photos({ items }: { items: CaretakerQueue["heldPhotos"] }) {
  return (
    <Section id="photos" title="Photos held back" count={items.length} empty="Every photo is public or has no cat yet.">
      {items.map((p) => (
        <li key={p.sightingId} className="card">
          <h3 className="text-base font-extrabold">{p.catName ?? "No cat yet"}</h3>
          <p className="small">Taken {p.date}. Not shown publicly.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route */}
          <img src={`/api/caretaker/images/sighting/${p.sightingId}`} alt="The original photo" className="mt-3 max-h-72 w-full rounded-in object-contain" />
          <ActionForm action="photo_publish" submitLabel="Publish with areas blurred">
            <Hidden name="sightingId" value={p.sightingId} />
            {p.hasRegions ? (
              <p className="small">The AI marked areas to blur. They will be blurred.</p>
            ) : (
              <label className="flex items-start gap-3">
                <input type="checkbox" name="noSensitive" value="on" className="mt-1 h-5 w-5" />
                <span>No house numbers, signs or plates visible</span>
              </label>
            )}
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

const SEX_OPTIONS = ["unknown", "female", "male"] as const;
const FLAG_OPTIONS = ["pregnant", "injured", "sick", "kitten"] as const;

function EarTips({ items }: { items: CaretakerQueue["earTipPending"] }) {
  return (
    <Section id="ears" title="Cats with no ear-tip decision" count={items.length} empty="Every spotted cat has its ears settled.">
      {items.map((c) => (
        <li key={c.id} className="card">
          <h3 className="text-base font-extrabold">{c.name}</h3>
          <p className="small">
            Neighbours so far: {c.yes} said ear-tipped, {c.no} said not.
          </p>
          <Where exact={c.exact} />
          <ActionForm action="cat_set_ear_tip" submitLabel="Ear is tipped, already neutered">
            <Hidden name="catId" value={c.id} />
            <Hidden name="earTip" value="present" />
          </ActionForm>
          <ActionForm action="cat_set_ear_tip" submitLabel="Ear is not tipped, join the queue" quiet>
            <Hidden name="catId" value={c.id} />
            <Hidden name="earTip" value="absent" />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

function NeuteredWithoutRecord({ items }: { items: CaretakerQueue["neuteredWithoutRecord"] }) {
  return (
    <Section id="neutered" title="Neutered with no vet record" count={items.length} empty="Every neutered cat has a vet record.">
      {items.map((c) => (
        <li key={c.id} className="card">
          <h3 className="text-base font-extrabold">{c.name}</h3>
          <p className="small">Marked neutered without a vet. No money is set aside for this cat.</p>
          <ActionForm action="cat_undo_neutered" submitLabel="Not neutered, back to the queue" quiet>
            <Hidden name="catId" value={c.id} />
          </ActionForm>
        </li>
      ))}
    </Section>
  );
}

function Cats({ cats }: { cats: CaretakerQueue["catChoices"] }) {
  return (
    <section className="mt-10" aria-labelledby="cats">
      <h2 id="cats" className="h2">
        Cat cards
      </h2>
      <p className="mt-2 small soft">The 200 newest cats. Sex and flags, ear-tip, and the last steps to a home.</p>
      <ul className="mt-4 grid gap-3">
        {cats.map((c) => (
          <li key={c.id} className="card">
            <h3 className="text-base font-extrabold">
              {c.name} <span className="font-normal soft">{c.status}</span>
            </h3>
            <ActionForm action="cat_set_details" submitLabel="Save sex and flags" quiet>
              <Hidden name="catId" value={c.id} />
              <label className="grid gap-1">
                <span className="font-bold">Sex</span>
                <select name="sex" className="field" defaultValue={c.sex}>
                  {SEX_OPTIONS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="flex flex-wrap gap-4">
                <legend className="font-bold">Flags</legend>
                {FLAG_OPTIONS.map((f) => (
                  <label key={f} className="flex items-center gap-2">
                    <input type="checkbox" name="flags[]" value={f} defaultChecked={c.flags.includes(f)} className="h-5 w-5" />
                    {f}
                  </label>
                ))}
              </fieldset>
            </ActionForm>
            {c.status === "spotted" || c.status === "queued" ? (
              <ActionForm action="cat_set_ear_tip" submitLabel="Ear is tipped, already neutered" quiet>
                <Hidden name="catId" value={c.id} />
                <Hidden name="earTip" value="present" />
              </ActionForm>
            ) : null}
            {c.status === "neutered" && (
              <ActionForm action="cat_adoptable" submitLabel="Mark ready for a home" quiet>
                <Hidden name="catId" value={c.id} />
              </ActionForm>
            )}
            {c.status === "adoptable" && (
              <ActionForm action="cat_adopted" submitLabel="Mark adopted" quiet>
                <Hidden name="catId" value={c.id} />
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Rules({ rules }: { rules: RulesView }) {
  const l = rules.limits;
  const pesos = (c: number) => c / 100;
  return (
    <section className="mt-10" aria-labelledby="rules">
      <h2 id="rules" className="h2">
        Spending rules
      </h2>
      <p className="mt-2 small soft">
        Whole pesos. Lowering a cap also applies to payouts already waiting for approval. Every change is written to the treasurer&apos;s public feed as a change, without the values.
      </p>
      <div className="card mt-4">
        <ActionForm action="guardrails_update" submitLabel="Save rules">
          <Field label="Care package price" name="packagePrice" type="number" defaultValue={pesos(l.packagePrice)} />
          <Field label="Deposit percent (1 to 100)" name="depositPct" type="number" defaultValue={l.depositPct} />
          <Field label="Cap per cat" name="maxPerCat" type="number" defaultValue={pesos(l.maxPerCat)} />
          <Field label="Cap per day" name="maxPerDay" type="number" defaultValue={pesos(l.maxPerDay)} />
          <Field label="Approval threshold" name="approvalThreshold" type="number" defaultValue={pesos(l.approvalThreshold)} hint="Payouts above this wait for a caretaker." />
          <Field label="Cat match confidence minimum (0 to 1)" name="matchConfidenceMin" defaultValue={l.matchConfidenceMin} />
        </ActionForm>
      </div>

      <h3 className="mt-8 h2">Vets</h3>
      <ul className="mt-4 grid gap-3">
        {rules.vets.map((v) => (
          <li key={v.id} className="card">
            <h4 className="h2">
              {v.username} <span className="font-normal soft">{v.allowed ? "can be paid" : "not allowed"}</span>
            </h4>
            {v.allowed ? (
              <ActionForm action="payee_remove" submitLabel="Stop payments to this vet" quiet>
                <Hidden name="userId" value={v.id} />
              </ActionForm>
            ) : (
              <ActionForm action="payee_add" submitLabel="Allow payments to this vet" quiet>
                <Hidden name="username" value={v.username} />
              </ActionForm>
            )}
            <ActionForm action="vet_update" submitLabel="Save vet details">
              <Hidden name="userId" value={v.id} />
              <Field label="Clinic name on receipts" name="clinicName" defaultValue={v.clinicName ?? ""} />
              <Field label="PayPal email" name="paypalEmail" type="email" defaultValue={v.paypalEmail ?? ""} />
            </ActionForm>
          </li>
        ))}
      </ul>
      <div className="card mt-5">
        <h4 className="h2">Allow another vet</h4>
        <ActionForm action="payee_add" submitLabel="Allow">
          <Field label="Vet username" name="username" />
        </ActionForm>
      </div>
    </section>
  );
}

async function Desk() {
  await connection();
  const session = await getSession();
  if (!session) {
    return (
      <div className="card mt-8">
        <p className="font-bold">This page is for caretakers.</p>
        <p className="small soft mt-1">In the demo, pick the Caretaker role in the bar at the top.</p>
      </div>
    );
  }
  if (session.role !== "caretaker") {
    return <p className="note note-bad mt-8 font-bold">This page is for caretakers.</p>;
  }

  const [q, rules] = await Promise.all([getCaretakerQueue(), getRulesView()]);
  return (
    <>
      <Approvals items={q.awaitingApproval} />
      <NeedsReview items={q.needsReview} />
      <LongSent items={q.longSent} />
      <Sightings items={q.sightings} cats={q.catChoices} />
      <EarTipConfirmations items={q.earTipConfirmations} />
      <Receipts items={q.receipts} />
      <Reviews items={q.reviews} />
      <Wakeups items={q.failedWakeups} />
      <Photos items={q.heldPhotos} />
      <EarTips items={q.earTipPending} />
      <NeuteredWithoutRecord items={q.neuteredWithoutRecord} />
      <Cats cats={q.catChoices} />
      <Rules rules={rules} />
    </>
  );
}

export default function CaretakerPage() {
  return (
    <main>
      <PageHead title="Caretaker desk">
        The treasurer asks you when it is unsure. Exact locations and private photos show here, and nowhere public.
      </PageHead>
      <Suspense fallback={<ListSkeleton rows={3} label="Loading" />}>
        <Desk />
      </Suspense>
    </main>
  );
}
