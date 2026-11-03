import { and, eq, sql } from "drizzle-orm";
import { withColonyLock } from "../db/client";
import { allowedPayees, guardrails, users } from "../db/schema";
import { audit, pesosToCentavos, reqText, reqUuid, Refusal, type Handler } from "./shared";


function confidence(raw: unknown, label: string): number {
  const v = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^(0(\.\d{1,2})?|1(\.0{1,2})?|\.\d{1,2})$/.test(v)) {
    throw new Refusal(400, `${label} must be a number from 0 to 1 with at most two decimals, such as 0.85.`);
  }
  return Number(v);
}

function percent(raw: unknown): number {
  const v = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 100) {
    throw new Refusal(400, "The deposit percent must be a whole number from 1 to 100.");
  }
  return Number(v);
}

/** Pesos in the form, centavos stored. Nothing changes unless every value is valid. */
export const guardrailsUpdate: Handler = async (caretakerId, body) => {
  const next = {
    packagePrice: pesosToCentavos(body.packagePrice, "The package price"),
    depositPct: percent(body.depositPct),
    maxPerCat: pesosToCentavos(body.maxPerCat, "The cap per cat"),
    maxPerDay: pesosToCentavos(body.maxPerDay, "The cap per day"),
    approvalThreshold: pesosToCentavos(body.approvalThreshold, "The approval threshold"),
    earTipConfidenceMin: confidence(body.earTipConfidenceMin, "The ear-tip confidence"),
    matchConfidenceMin: confidence(body.matchConfidenceMin, "The match confidence"),
  };
  if (next.approvalThreshold > next.maxPerCat) {
    throw new Refusal(400, "The approval threshold cannot be above the cap per cat.");
  }
  if (next.maxPerDay < next.maxPerCat) throw new Refusal(400, "The cap per day cannot be below the cap per cat.");
  if (next.packagePrice > next.maxPerCat) throw new Refusal(400, "The package price cannot be above the cap per cat.");

  return withColonyLock(async (tx) => {
    const [old] = await tx.select().from(guardrails).where(eq(guardrails.id, 1)).for("update");
    if (!old) throw new Refusal(404, "The spending rules are missing.");
    const before = { ...old } as Record<string, number>;
    delete before.id;
    const changed = Object.keys(next).filter((k) => before[k] !== (next as Record<string, number>)[k]);
    if (changed.length === 0) return "No change. The rules are already set to these values.";
    await tx.update(guardrails).set(next).where(eq(guardrails.id, 1));
    await audit(tx, {
      action: "guardrails_changed",
      caretakerId,
      reason: "A caretaker changed the spending rules.",
      inputs: { changed, old: before, new: next },
    });
    return "Saved. The new rules apply from now on, including to payouts still waiting for approval.";
  });
};

export const payeeAdd: Handler = async (caretakerId, body) => {
  const username = reqText(body, "username", "A username", 40);
  return withColonyLock(async (tx) => {
    const [user] = await tx.select().from(users).where(sql`lower(${users.username}) = ${username.toLowerCase()}`);
    if (!user) throw new Refusal(404, "There is no user with that name.");
    if (user.role !== "vet") throw new Refusal(400, "Only a vet account can be allowed to receive payments.");
    const added = await tx
      .insert(allowedPayees)
      .values({ userId: user.id, kind: "vet" })
      .onConflictDoNothing()
      .returning({ userId: allowedPayees.userId });
    if (added.length === 0) return `${user.username} is already allowed.`;
    await audit(tx, {
      action: "payee_added",
      caretakerId,
      reason: "A caretaker allowed a vet to be paid.",
      inputs: { userId: user.id },
    });
    return `${user.username} can now be paid.`;
  });
};

/** Paid payouts are history and stay as they are. A live booking's approval is denied from here on. */
export const payeeRemove: Handler = async (caretakerId, body) => {
  const userId = reqUuid(body, "userId", "The vet");
  return withColonyLock(async (tx) => {
    const removed = await tx
      .delete(allowedPayees)
      .where(and(eq(allowedPayees.userId, userId), eq(allowedPayees.kind, "vet")))
      .returning({ userId: allowedPayees.userId });
    if (removed.length === 0) return "That vet was not on the list.";
    await audit(tx, {
      action: "payee_removed",
      caretakerId,
      reason: "A caretaker stopped payments to a vet.",
      inputs: { userId },
    });
    return "Removed. No new payment to this vet will go out, and anything waiting for approval will be refused.";
  });
};

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export const vetUpdate: Handler = async (caretakerId, body) => {
  const userId = reqUuid(body, "userId", "The vet");
  const clinicName = reqText(body, "clinicName", "The clinic name", 80);
  if (clinicName.length < 2 || /[<>]/.test(clinicName)) {
    throw new Refusal(400, "The clinic name must be plain text of at least two characters.");
  }
  const email = reqText(body, "paypalEmail", "The PayPal email", 254).toLowerCase();
  if (!EMAIL.test(email)) throw new Refusal(400, "That does not look like an email address.");

  return withColonyLock(async (tx) => {
    const [vet] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!vet) throw new Refusal(404, "There is no such vet.");
    if (vet.role !== "vet") throw new Refusal(400, "Only a vet account has these details.");
    const changed = [
      ...(vet.clinicName !== clinicName ? ["clinicName"] : []),
      ...(vet.paypalEmail !== email ? ["paypalEmail"] : []),
    ];
    if (changed.length === 0) return "No change.";
    await tx.update(users).set({ clinicName, paypalEmail: email }).where(eq(users.id, userId));
    // The address is private and stays out of the audit row. Only the fact of the change is kept.
    await audit(tx, {
      action: "vet_details_changed",
      caretakerId,
      reason: "A caretaker updated a vet's details.",
      inputs: { userId, changed },
    });
    return "Saved.";
  });
};

