"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useId, useState } from "react";
import { CURRENCY, MAX_DONATION, MIN_DONATION } from "@/lib/config";
import { formatPeso, parsePesoInput } from "@/lib/money";
import { SignIn } from "./SignIn";

const PRESETS = [10_000, 50_000, 150_000] as const;

type Outcome =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "captured"; gross: number; net: number }
  | { kind: "waiting" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export function DonateForm({ clientId, username }: { clientId: string; username: string | null }) {
  const customId = useId();
  const [preset, setPreset] = useState<number | "other">(50_000);
  const [custom, setCustom] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  const amount = preset === "other" ? parsePesoInput(custom) : preset;
  const amountError =
    preset === "other" && custom !== "" && (amount === null || amount < MIN_DONATION || amount > MAX_DONATION)
      ? `Enter an amount from ${formatPeso(MIN_DONATION)} to ${formatPeso(MAX_DONATION)}`
      : null;
  const valid = amount !== null && amount >= MIN_DONATION && amount <= MAX_DONATION;

  if (!username) {
    return (
      <div className="mt-8">
        <p className="mb-4">Sign in so we can link your donation to you.</p>
        <SignIn username={null} inline />
      </div>
    );
  }

  if (outcome.kind === "captured") {
    const fee = outcome.gross - outcome.net;
    return (
      <div className="mt-8" role="status">
        <div className="ticket">
          <h2 className="text-3xl font-extrabold">Thank you, {username}.</h2>
          <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            <dt>You gave</dt>
            <dd className="text-right">{formatPeso(outcome.gross)}</dd>
            <dt>PayPal fee</dt>
            <dd className="text-right">{formatPeso(fee)}</dd>
            <dt className="mt-2 border-t-2 border-ink pt-2 font-bold">Reached the fund</dt>
            <dd className="mt-2 border-t-2 border-ink pt-2 text-right font-display text-2xl font-extrabold text-sampaguita">
              {formatPeso(outcome.net)}
            </dd>
          </dl>
        </div>
        <button type="button" className="btn-quiet mt-6" onClick={() => setOutcome({ kind: "idle" })}>
          Give again
        </button>
      </div>
    );
  }

  async function createOrder(): Promise<string> {
    setOutcome({ kind: "idle" });
    const res = await fetch("/api/donations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Only the amount goes to the server. It works out fee and net itself.
      body: JSON.stringify({ amount }),
    });
    const body = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string };
    if (!res.ok || !body.orderId) throw new Error(body.error ?? "Could not start the donation");
    return body.orderId;
  }

  async function onApprove(data: { orderID: string }) {
    setOutcome({ kind: "confirming" });
    const res = await fetch(`/api/donations/${encodeURIComponent(data.orderID)}/capture`, {
      method: "POST",
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      gross?: number;
      net?: number;
      error?: string;
    };
    if (!res.ok) {
      setOutcome({ kind: "error", message: body.error ?? "Could not confirm the payment" });
    } else if (body.status === "captured" && typeof body.gross === "number" && typeof body.net === "number") {
      setOutcome({ kind: "captured", gross: body.gross, net: body.net });
    } else {
      setOutcome({ kind: "waiting" });
    }
  }

  return (
    <div className="mt-8 grid gap-6">
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-bold">How much?</legend>
        <div role="radiogroup" aria-label="Amount" className="grid grid-cols-3 gap-3">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={preset === p}
              className="chip"
              onClick={() => setPreset(p)}
            >
              {formatPeso(p).replace(/\.00$/, "")}
            </button>
          ))}
        </div>
        <button
          type="button"
          role="radio"
          aria-checked={preset === "other"}
          className="chip text-base"
          onClick={() => setPreset("other")}
        >
          Other amount
        </button>
        {preset === "other" && (
          <div className="grid gap-1">
            <label htmlFor={customId} className="font-bold">
              Amount in pesos
            </label>
            <input
              id={customId}
              className="field"
              inputMode="decimal"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-invalid={amountError !== null}
              aria-describedby={`${customId}-help`}
              autoFocus
            />
            <p id={`${customId}-help`} className={amountError ? "font-bold text-chili" : "text-sm text-dusk"}>
              {amountError ?? `Minimum ${formatPeso(MIN_DONATION).replace(/\.00$/, "")}`}
            </p>
          </div>
        )}
      </fieldset>

      <p className="note">
        PayPal takes a fee from every donation. In our test payment, ₱100.00 became ₱81.60 after a ₱18.40
        fee. We show the real figure once you have paid.
      </p>

      <div aria-live="polite" className="grid gap-3">
        {outcome.kind === "confirming" && <p className="note">Confirming your payment with PayPal. Please wait.</p>}
        {outcome.kind === "waiting" && (
          <p className="note">
            PayPal has not confirmed your payment yet. It will count once PayPal does. You do not need to pay
            again.
          </p>
        )}
        {outcome.kind === "cancelled" && (
          <p className="note">You cancelled, so nothing was charged. Pick an amount to try again.</p>
        )}
        {outcome.kind === "error" && (
          <p role="alert" className="note note-bad font-bold">
            {outcome.message}. If PayPal took money, it will still be counted. Otherwise, try again.
          </p>
        )}
      </div>

      {valid && outcome.kind !== "confirming" ? (
        clientId ? (
          <PayPalScriptProvider options={{ clientId, currency: CURRENCY, intent: "capture" }}>
            <PayPalButtons
              style={{ layout: "vertical", shape: "rect", label: "donate", color: "gold" }}
              forceReRender={[amount, CURRENCY]}
              createOrder={createOrder}
              onApprove={onApprove}
              onCancel={() => setOutcome({ kind: "cancelled" })}
              onError={(e) =>
                setOutcome({
                  kind: "error",
                  message: e instanceof Error && e.message ? e.message : "Something went wrong with PayPal",
                })
              }
            />
          </PayPalScriptProvider>
        ) : (
          <p role="alert" className="note note-bad font-bold">
            Payments are not set up on this server.
          </p>
        )
      ) : (
        <button className="btn" disabled>
          {outcome.kind === "confirming" ? "Confirming" : "Choose an amount"}
        </button>
      )}
    </div>
  );
}
