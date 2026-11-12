"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import Link from "next/link";
import { useId, useState } from "react";
import { CURRENCY, MAX_DONATION, MIN_DONATION } from "@/lib/config";
import { formatPeso, parsePesoInput } from "@/lib/money";
import { feeNote, testMoneyLine } from "@/lib/moneyCopy";
import { JUDGE_ONLY_LINE } from "@/lib/judgeLine";
import { SignInGate } from "./SignInGate";

const PRESETS = [10_000, 50_000, 150_000] as const;

type Outcome =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "captured"; gross: number; net: number }
  | { kind: "waiting" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export function DonateForm({ clientId, username, testMoney = true, judge }: { clientId: string; username: string | null; testMoney?: boolean; judge: boolean }) {
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

  if (!judge) {
    return <p className="note mt-6">{JUDGE_ONLY_LINE}</p>;
  }

  if (!username) {
    return (
      <SignInGate>
        <p className="font-bold">Give ₱100, ₱500, ₱1,500 or any amount through PayPal.</p>
      </SignInGate>
    );
  }

  if (outcome.kind === "captured") {
    const fee = outcome.gross - outcome.net;
    return (
      <div className="mt-4" role="status">
        <div className="card">
          <h2 className="title">Thank you, {username}.</h2>
          <p className="mt-2 text-lg font-bold leading-snug">Your gift is in the shared fund.</p>
          <p className="mt-1">The AI treasurer funds the next cat once there&apos;s enough. You can watch it happen.</p>
          <div className="mt-4 grid gap-3">
            <Link href="/ledger" className="btn w-full">
              See your gift in the Ledger
            </Link>
            <Link href="/agent" className="btn-quiet w-full">
              Watch the treasurer
            </Link>
          </div>
          <dl className="mt-5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            <dt>You gave</dt>
            <dd className="text-right">{formatPeso(outcome.gross)}</dd>
            <dt>PayPal fee</dt>
            <dd className="text-right">{formatPeso(fee)}</dd>
            <dt className="mt-3 rounded-l-in bg-pale px-3 py-2 font-bold">Reached the fund</dt>
            <dd className="mt-3 rounded-r-in bg-pale px-3 py-2 text-right text-xl font-extrabold text-main">
              {formatPeso(outcome.net)}
            </dd>
          </dl>
        </div>
        {testMoneyLine(testMoney) && <p className="small soft mt-3">{testMoneyLine(testMoney)}</p>}
        <button type="button" className="link mt-1 min-h-11" onClick={() => setOutcome({ kind: "idle" })}>
          Give again
        </button>
      </div>
    );
  }

  async function createOrder(): Promise<string> {
    setOutcome({ kind: "idle" });
    // One id per tap, reused if this tap has to be sent again, so PayPal hands back the same order instead of a second.
    const attemptId = crypto.randomUUID();
    let lastError = "Could not start the donation";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/donations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Only the amount goes to the server. It works out fee and net itself.
          body: JSON.stringify({ amount, attemptId }),
        });
        const body = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string };
        if (res.ok && body.orderId) return body.orderId;
        lastError = body.error ?? lastError;
        // Only a server fault is worth sending again; a refusal would be refused again.
        if (res.status < 500) break;
      } catch {
        // The connection dropped; the same attempt id makes the second send safe.
      }
    }
    throw new Error(lastError);
  }

  async function onApprove(data: { orderID: string }) {
    setOutcome({ kind: "confirming" });
    try {
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
    } catch {
      // The connection dropped, so we do not know whether the payment went through.
      setOutcome({
        kind: "error",
        message: "We lost the connection before PayPal confirmed your payment",
      });
    }
  }

  return (
    <div className="mt-6 grid gap-5">
      <fieldset className="grid gap-3">
        <legend className="mb-2 h2">How much?</legend>
        <div role="radiogroup" aria-label="Amount" className="grid grid-cols-3 gap-3">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={preset === p}
              className="chip chip-amount"
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
          className="chip"
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
            <p id={`${customId}-help`} className={amountError ? "font-bold text-danger" : "small soft"}>
              {amountError ?? `Minimum ${formatPeso(MIN_DONATION).replace(/\.00$/, "")}`}
            </p>
          </div>
        )}
      </fieldset>

      <p className="note">
        {feeNote(testMoney)}
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
            {outcome.message}. Check your PayPal activity before paying again. If PayPal took the money, it will still be counted.
          </p>
        )}
      </div>

      {valid && outcome.kind !== "confirming" && outcome.kind !== "waiting" ? (
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
        <button className="btn w-full" disabled>
          {outcome.kind === "confirming" ? "Confirming" : outcome.kind === "waiting" ? "Waiting for PayPal" : "Choose an amount"}
        </button>
      )}
    </div>
  );
}
