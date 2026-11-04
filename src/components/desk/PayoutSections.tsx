import { ActionForm } from "../ActionForm";
import { formatPeso, formatPesoShort } from "@/lib/money";
import { approvalNotice } from "@/lib/reportNotice";
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
          {approvalNotice(p.catReport) && <p className="note note-bad mt-2 small font-bold">{approvalNotice(p.catReport)}</p>}
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
          {p.itemStatus && <p className="small soft">PayPal last said: {p.itemStatus}</p>}
          {p.lastGatewayError && <p className="note note-bad mt-2 small break-words">Last gateway error: {p.lastGatewayError}</p>}
          {p.canAllowRetry ? (
            <>
              <p className="mt-2 small">
                {p.status === "rejected" ? "This payout was rejected and never sent to PayPal, and it now stops the treasurer from asking again." : "PayPal refused this payout on its first try and has no record of it, and it now stops the treasurer from asking again."} If it was a mistake, allow one more try.
              </p>
              <ActionForm
                action="payout_allow_retry"
                submitLabel="Allow a new try"
                confirm={{ question: `Let the treasurer try ${formatPesoShort(p.amount)} to ${p.vetName} once more?`, send: "Allow" }}
              >
                <Hidden name="payoutId" value={p.id} />
                <Field label="Note: why" name="note" missing="Say why a new try is right." />
              </ActionForm>
            </>
          ) : (
            <>
              {p.lateSuccess ? (
                <p className="note note-bad mt-2 small">
                  PayPal says this succeeded after we had called it failed. The treasurer will never ask for it again. Check PayPal, then say what happened.
                </p>
              ) : !p.canRulePaid ? (
                <p className="mt-2 small">Check this at PayPal. A developer must close it.</p>
              ) : !p.canRuleNotPaid ? (
                <p className="mt-2 small">Check this at PayPal. If it was paid, record it here. If it was not, a developer must close it.</p>
              ) : (
                <p className="mt-2 small">Check PayPal activity first. Money may have left even if this shows an error.</p>
              )}
              {p.canRulePaid && (
                <ActionForm
                  action="payout_resolve"
                  submitLabel={p.lateSuccess ? "Paid" : "It was paid"}
                  confirm={
                    p.lateSuccess
                      ? { question: `Record ${formatPesoShort(p.amount)} to ${p.vetName} as paid? The books will count it. This can't be undone.`, send: "Record as paid" }
                      : undefined
                  }
                >
                  <Hidden name="payoutId" value={p.id} />
                  <Hidden name="outcome" value="paid" />
                  {p.lateSuccess && p.batchId ? (
                    <Hidden name="paypalRef" value={p.batchId} />
                  ) : (
                    <Field label="PayPal reference" name="paypalRef" missing="Add the PayPal reference." />
                  )}
                </ActionForm>
              )}
              {p.canRuleNotPaid && (
                <ActionForm action="payout_resolve" submitLabel={p.lateSuccess ? "Not paid" : "It was not paid"} quiet>
                  <Hidden name="payoutId" value={p.id} />
                  <Hidden name="outcome" value="not_paid" />
                  <Field
                    label={p.lateSuccess ? "Note: what you checked at PayPal" : "Note: what you checked"}
                    name="note"
                    missing={p.lateSuccess ? "Say what you checked at PayPal." : "Say what you checked."}
                  />
                </ActionForm>
              )}
            </>
          )}
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
