import type { PublicAgentAction } from "@/server/public";

const FIRST = "Vet first payment";
const FINAL = "Vet final payment";
const STOPPED = ["Rejected", "Refused by the rules"];

const isPayment = (a: Pick<PublicAgentAction, "action">) => a.action === FIRST || a.action === FINAL;

/** Starts with a plain verb and the cat, so a row reads as one sentence. Other actions already read that way. */
export function feedHeadline(a: Pick<PublicAgentAction, "action" | "cat" | "status">): string {
  const who = a.cat ?? "a cat";
  if (a.action === "Funded a cat") return `Set money aside for ${who}`;
  if (!isPayment(a)) return a.cat ? `${a.action}: ${a.cat}` : a.action;
  const what = a.action === FIRST ? "first payment" : "final payment";
  if (a.status === "Sent") return `Sent the ${what} for ${who}, waiting for PayPal`;
  if (a.status === "Being checked") return `Checking the ${what} for ${who}`;
  const verb =
    a.status === "Paid" ? "Paid" :
    a.status === "Failed" ? "Could not send" :
    STOPPED.includes(a.status) ? "Held back" :
    a.status === "Waiting for approval" ? "Proposed" :
    "Sending";
  return `${verb} the ${what} for ${who}`;
}

/** What the AI proposed and what a person did about it. Only said when the data says so. */
export function feedStory(a: Pick<PublicAgentAction, "action" | "status" | "signedOffByPerson">): { ai: string; person: string | null } | null {
  if (a.action === "Funded a cat") return { ai: "The AI treasurer chose this cat, inside the spending rules.", person: null };
  if (!isPayment(a)) return null;
  const ai = "The AI treasurer proposed it.";
  if (a.status === "Refused by the rules") return { ai, person: "The spending rules stopped it." };
  if (a.status === "Rejected") return { ai, person: "It was stopped and nothing was paid." };
  if (a.status === "Being checked") return { ai, person: "A caretaker needs to check this." };
  if (a.signedOffByPerson) return { ai, person: "A caretaker signed it off." };
  if (a.status === "Waiting for approval") return { ai, person: "Waiting for a caretaker to sign it off." };
  // A Paid row with no sign-off may be a late SUCCESS a caretaker ruled Paid, which needed no sign-off, so this does not claim none was needed.
  if (a.status === "Paid") return { ai, person: "No caretaker signed it off." };
  return { ai, person: "No sign-off was needed. It was within the spending rules." };
}
