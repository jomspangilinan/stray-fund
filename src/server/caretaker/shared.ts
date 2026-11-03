import type { Tx } from "../db/client";
import { agentActions } from "../db/schema";
import { isUuid } from "../public";

/** A refusal the caretaker should read as it is written. Messages are written here, never taken from input. */
export class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export type Body = Record<string, unknown>;
/** The message to show. A handler throws Refusal when it cannot do what was asked. */
export type Handler = (caretakerId: string, body: Body) => Promise<string>;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Trimmed text of 1 to max characters, with no control characters. */
export function reqText(body: Body, key: string, label: string, max = 500): string {
  const raw = body[key];
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) throw new Refusal(400, `${label} is required.`);
  if (v.length > max) throw new Refusal(400, `${label} must be ${max} characters or fewer.`);
  if (CONTROL.test(v)) throw new Refusal(400, `${label} has characters that are not allowed.`);
  return v;
}

export function reqUuid(body: Body, key: string, label: string): string {
  const raw = body[key];
  if (typeof raw !== "string" || !isUuid(raw)) throw new Refusal(400, `${label} is missing or not valid.`);
  return raw;
}

/** A checkbox: true, or the strings a browser sends. */
export function flag(body: Body, key: string): boolean {
  const v = body[key];
  return v === true || v === "on" || v === "true" || v === "1";
}

/** Whole pesos, as a person types them, to centavos. */
export function pesosToCentavos(raw: unknown, label: string): number {
  const v = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,7}$/.test(v)) throw new Refusal(400, `${label} must be a whole number of pesos, such as 1500.`);
  const pesos = Number(v);
  if (pesos < 1) throw new Refusal(400, `${label} must be at least 1 peso.`);
  return pesos * 100;
}


/**
 * Every caretaker action that changes something leaves a row here. The reason is a fixed
 * sentence, since the public feed prints it. Whatever the caretaker typed goes in inputs,
 * which the feed never reads. Nothing secret goes in either.
 */
export async function audit(
  tx: Tx,
  a: { action: string; caretakerId: string; reason: string; inputs: object; amount?: number },
): Promise<void> {
  await tx.insert(agentActions).values({
    action: a.action,
    inputs: a.inputs,
    reason: a.reason,
    amount: a.amount ?? null,
    status: "done",
    approvedBy: a.caretakerId,
  });
}
