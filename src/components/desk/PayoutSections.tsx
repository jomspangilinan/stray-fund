import { ActionForm } from "../ActionForm";
import { formatPeso, formatPesoShort } from "@/lib/money";
import type { PayoutItem } from "@/server/caretaker/queue";
import { DeskItem } from "./DeskItem";
import { Section } from "./DeskParts";
import { Field, Hidden } from "./Fields";

const KIND: Record<string, string> = { deposit: "Deposit", balance: "Balance" };

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

const label = (p: PayoutItem) => `${KIND[p.kind] ?? p.kind} for ${p.catName}`;

export function Approvals({ items }: { items: PayoutItem[] }) {
  return (
    <Section id="approvals" count={items.length}>
      {items.map((p) => (
        <DeskItem key={p.id} label={label(p)}>
          <PayoutFacts p={p} />
          <ActionForm
            action="payout_approve"
            submitLabel="Approve and send"
            confirm={{ question: `Send ${formatPesoShort(p.amount)} to ${p.vetName}? This can't be undone.`, send: "Send" }}
          >
            <Hidden name="payoutId" value={p.id} />
          </ActionForm>
          <ActionForm action="payout_reject" submitLabel="Reject" quiet>
            <Hidden name="payoutId" value={p.id} />
            <Field label="Reason" name="reason" missing="Say why you are rejecting it." />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}

export function NeedsReview({ items }: { items: PayoutItem[] }) {
  return (
    <Section id="payout-review" count={items.length}>
      {items.map((p) => (
        <DeskItem key={p.id} label={label(p)}>
          <PayoutFacts p={p} />
          {p.lastGatewayError && <p className="note note-bad mt-2 small break-words">Last gateway error: {p.lastGatewayError}</p>}
          <p className="mt-2 small">Check PayPal activity first. Money may have left even if this shows an error.</p>
          <ActionForm action="payout_resolve" submitLabel="It was paid">
            <Hidden name="payoutId" value={p.id} />
            <Hidden name="outcome" value="paid" />
            <Field label="PayPal reference" name="paypalRef" missing="Add the PayPal reference." />
          </ActionForm>
          <ActionForm action="payout_resolve" submitLabel="It was not paid" quiet>
            <Hidden name="payoutId" value={p.id} />
            <Hidden name="outcome" value="not_paid" />
            <Field label="Note: what you checked" name="note" missing="Say what you checked." />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}

export function LongSent({ items }: { items: PayoutItem[] }) {
  return (
    <Section id="long-sent" count={items.length}>
      {items.map((p) => (
        <DeskItem key={p.id} label={label(p)}>
          <PayoutFacts p={p} />
          <p className="note mt-2 small">
            Warning: PayPal has not confirmed this yet. If the vet&apos;s PayPal email has no account, the money stays
            unclaimed. Ask the vet to check, then leave a note. Nothing else can be done here.
          </p>
          <ActionForm action="payout_note" submitLabel="Save note" quiet>
            <Hidden name="payoutId" value={p.id} />
            <Field label="Note" name="note" missing="Write a note first." />
          </ActionForm>
        </DeskItem>
      ))}
    </Section>
  );
}
