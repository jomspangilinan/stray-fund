import { ActionForm } from "../ActionForm";
import type { RulesView } from "@/server/caretaker/queue";
import { Field, Hidden } from "./Fields";

export function Rules({ rules }: { rules: RulesView }) {
  const l = rules.limits;
  const pesos = (c: number) => c / 100;
  return (
    <section className="mt-8" aria-labelledby="rules">
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

      <h2 className="mt-8 h2">Vets</h2>
      <ul className="mt-4 grid gap-3">
        {rules.vets.map((v) => (
          <li key={v.id} className="card">
            <h3 className="h2">
              {v.username} <span className="font-normal soft">{v.allowed ? "can be paid" : "not allowed"}</span>
            </h3>
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
              <Field
                label="PayPal email"
                name="paypalEmail"
                type="email"
                defaultValue={v.emailHidden ? "" : (v.paypalEmail ?? "")}
                hint={v.emailHidden ? `Hidden in the demo (${v.paypalEmail ?? "none"}). Type a new address to change it.` : undefined}
              />
            </ActionForm>
          </li>
        ))}
      </ul>
      <div className="card mt-5">
        <h3 className="h2">Allow another vet</h3>
        <ActionForm action="payee_add" submitLabel="Allow">
          <Field label="Vet username" name="username" />
        </ActionForm>
      </div>
    </section>
  );
}
