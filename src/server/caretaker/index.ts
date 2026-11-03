import { IllegalTransition } from "../catTransitions";
import { describeError } from "../errors";
import { catAdoptable, catAdopted, catSetDetails, catSetEarTip, photoHold, photoPublish, sightingConfirmNew, sightingMerge, sightingReject, wakeupDismiss, wakeupRetry } from "./cats";
import { evidenceAccept, evidenceConfirmEarTip, evidenceReject, reviewResolve } from "./evidence";
import { payoutApprove, payoutNote, payoutReject, payoutResolve } from "./payouts";
import { guardrailsUpdate, payeeAdd, payeeRemove, vetUpdate } from "./rules";
import { Refusal, type Body, type Handler } from "./shared";

export { setGatewayForTests } from "./payouts";

const HANDLERS = {
  payout_approve: payoutApprove,
  payout_reject: payoutReject,
  payout_resolve: payoutResolve,
  payout_note: payoutNote,
  evidence_accept: evidenceAccept,
  evidence_confirm_ear_tip: evidenceConfirmEarTip,
  evidence_reject: evidenceReject,
  review_resolve: reviewResolve,
  sighting_confirm_new: sightingConfirmNew,
  sighting_merge: sightingMerge,
  sighting_reject: sightingReject,
  cat_set_details: catSetDetails,
  cat_set_ear_tip: catSetEarTip,
  cat_adoptable: catAdoptable,
  cat_adopted: catAdopted,
  photo_publish: photoPublish,
  photo_hold: photoHold,
  guardrails_update: guardrailsUpdate,
  payee_add: payeeAdd,
  payee_remove: payeeRemove,
  vet_update: vetUpdate,
  wakeup_retry: wakeupRetry,
  wakeup_dismiss: wakeupDismiss,
} satisfies Record<string, Handler>;

export const ACTION_NAMES = Object.keys(HANDLERS);
export const isAction = (name: string): name is keyof typeof HANDLERS => Object.hasOwn(HANDLERS, name);

export type ActionReply = { status: 200 | 400 | 403 | 404 | 409 | 500; ok: boolean; message: string };

/** The role has been checked by the caller. Every failure comes back as plain words. */
export async function runAction(name: keyof typeof HANDLERS, caretakerId: string, body: Body): Promise<ActionReply> {
  try {
    return { status: 200, ok: true, message: await HANDLERS[name](caretakerId, body) };
  } catch (e) {
    if (e instanceof Refusal) return { status: e.status, ok: false, message: e.message };
    if (e instanceof IllegalTransition) return { status: 409, ok: false, message: "That change is not allowed from the cat's current step." };
    console.error(`[caretaker] ${name} failed: ${describeError(e)}`);
    return { status: 500, ok: false, message: "Something went wrong and nothing was changed. Try again." };
  }
}
