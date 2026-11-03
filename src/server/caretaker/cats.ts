import { and, eq, sql } from "drizzle-orm";
import { insertNewCat, publishPhoto } from "../spot";
import { resolveReviewBySubject } from "../agent/review";
import { disagreementSubject, lateYesSubject } from "../earTipFlags";
import { IllegalTransition, MoneyAlreadyMoved, markAlreadyNeutered, transitionCat } from "../catTransitions";
import { AssessmentSchema } from "../ai/schemas";
import { withColonyLock, type Tx } from "../db/client";
import { allocations, cats, earTipFlags, nameSuggestions, payouts, sightings, treatments, wakeups } from "../db/schema";
import { uniqueName } from "../catNames";
import { NAME_APPROVED, NAME_DISMISSED, NAME_SET } from "../privateActions";
import { parseCatName } from "@/lib/catNames";
import { publishScrubbed, type Box } from "../photos";
import { StoredObjectMissing } from "../storage";
import { enqueueWakeup } from "../wakeups";
import { audit, flag, reqUuid, Refusal, type Handler } from "./shared";
import type { CatStatus } from "@/lib/catState";

const SEXES = ["female", "male", "unknown"] as const;
const FLAGS = ["pregnant", "injured", "sick", "kitten"] as const;

type Sighting = typeof sightings.$inferSelect;

/** Locks the row and refuses anything that is not waiting for a person. */
async function loadWaiting(tx: Tx, id: string): Promise<Sighting> {
  const [s] = await tx.select().from(sightings).where(eq(sightings.id, id)).for("update");
  if (!s) throw new Refusal(404, "There is no such sighting.");
  if (s.state !== "needs_review") throw new Refusal(409, "This sighting has already been settled.");
  return s;
}

/** The photo is published after the commit, since storage is not part of the transaction. */
async function publishAfter(s: Sighting): Promise<void> {
  const regions = (s.assessment as { sensitive_regions?: unknown } | null)?.sensitive_regions;
  await publishPhoto(s.id, s.originalKey, regions);
}

export const sightingConfirmNew: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  const s = await withColonyLock(async (tx) => {
    const s = await loadWaiting(tx, sightingId);
    const parsed = AssessmentSchema.safeParse(s.assessment);
    const assessment = parsed.success ? parsed.data : null;

    // Review reasons never start a card, so a sighting here has no cat yet.
    if (s.catId) {
      throw new Refusal(409, "This photo was matched to a cat we already know. Confirm that match, or choose another cat.");
    }
    const catId = (await insertNewCat(tx, s, assessment)).id;
    await tx.update(sightings).set({ catId, state: "new_cat" }).where(and(eq(sightings.id, s.id), eq(sightings.state, "needs_review")));
    await audit(tx, {
      action: "sighting_reviewed",
      caretakerId,
      reason: "A caretaker settled a sighting.",
      inputs: { sightingId, catId, outcome: "new_cat" },
    });
    return { ...s, catId };
  });
  await publishAfter(s);
  return "Confirmed as a new cat. Neighbours can now say whether it has an ear-tip.";
};

export const sightingMerge: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  const catId = reqUuid(body, "catId", "The cat");
  const s = await withColonyLock(async (tx) => {
    const s = await loadWaiting(tx, sightingId);
    const [cat] = await tx.select({ id: cats.id }).from(cats).where(eq(cats.id, catId)).for("share");
    if (!cat) throw new Refusal(404, "There is no such cat.");
    // Only the sighting moves. The cat keeps its fuzzed location.
    await tx.update(sightings).set({ catId, state: "matched" }).where(and(eq(sightings.id, s.id), eq(sightings.state, "needs_review")));
    await audit(tx, {
      action: "sighting_reviewed",
      caretakerId,
      reason: "A caretaker settled a sighting.",
      inputs: { sightingId, catId, outcome: "merged" },
    });
    return { ...s, catId };
  });
  await publishAfter(s);
  return "Merged. The photo now belongs to that cat.";
};

export const sightingReject: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  return withColonyLock(async (tx) => {
    const s = await loadWaiting(tx, sightingId);
    await tx.update(sightings).set({ state: "rejected" }).where(and(eq(sightings.id, s.id), eq(sightings.state, "needs_review")));
    await audit(tx, {
      action: "sighting_reviewed",
      caretakerId,
      reason: "A caretaker settled a sighting.",
      inputs: { sightingId, catId: s.catId, outcome: "rejected" },
    });
    return "Rejected. The photo will not be used.";
  });
};

export const catSetDetails: Handler = async (caretakerId, body) => {
  const catId = reqUuid(body, "catId", "The cat");
  const sex = SEXES.find((x) => x === body.sex);
  if (!sex) throw new Refusal(400, "Choose female, male or unknown.");
  const raw = body.flags === undefined ? [] : body.flags;
  if (!Array.isArray(raw) || raw.some((f) => !FLAGS.includes(f as (typeof FLAGS)[number]))) {
    throw new Refusal(400, "Flags can only be pregnant, injured, sick or kitten.");
  }
  const flags = FLAGS.filter((f) => raw.includes(f));
  return withColonyLock(async (tx) => {
    const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
    if (!cat) throw new Refusal(404, "There is no such cat.");
    await tx.update(cats).set({ sex, sexUnconfirmed: false, flags }).where(eq(cats.id, catId));
    await audit(tx, {
      action: "cat_updated",
      caretakerId,
      reason: "A caretaker updated a cat's card.",
      inputs: { catId, sex, flags, oldSex: cat.sex, oldFlags: cat.flags },
    });
    return "Saved.";
  });
};

// ---------- Names ----------

const NAME_DECIDED = "Someone has already decided this suggestion.";

/** The message after a name is set: says so plainly when the wanted name was taken and another was chosen. */
const namedMessage = (lead: string, wanted: string, name: string) =>
  name === wanted ? `${lead} The cat is now called ${name}.` : `${wanted} was already taken, so the cat is now called ${name}.`;

/** Locks the suggestion row and refuses one that is not waiting. */
async function loadPendingSuggestion(tx: Tx, id: string) {
  const [s] = await tx.select().from(nameSuggestions).where(eq(nameSuggestions.id, id)).for("update");
  if (!s) throw new Refusal(404, "There is no such suggestion.");
  if (s.status !== "pending") throw new Refusal(409, NAME_DECIDED);
  return s;
}

export const nameApprove: Handler = async (caretakerId, body) => {
  const suggestionId = reqUuid(body, "suggestionId", "The suggestion");
  return withColonyLock(async (tx) => {
    const s = await loadPendingSuggestion(tx, suggestionId);
    const [cat] = await tx.select().from(cats).where(eq(cats.id, s.catId)).for("update");
    if (!cat) throw new Refusal(404, "There is no such cat.");
    const name = await uniqueName(tx, s.name, cat.id);
    await tx.update(cats).set({ name, nameLocked: true }).where(eq(cats.id, cat.id));
    const now = new Date();
    await tx.update(nameSuggestions).set({ status: "approved", decidedBy: caretakerId, decidedAt: now }).where(eq(nameSuggestions.id, s.id));
    // The cat has its name now, so the other waiting ideas for it are closed.
    const others = await tx
      .update(nameSuggestions)
      .set({ status: "dismissed", decidedBy: caretakerId, decidedAt: now })
      .where(and(eq(nameSuggestions.catId, cat.id), eq(nameSuggestions.status, "pending")))
      .returning({ id: nameSuggestions.id });
    await audit(tx, {
      action: NAME_APPROVED,
      caretakerId,
      reason: "A caretaker approved a cat's name.",
      inputs: { catId: cat.id, suggestionId: s.id, from: cat.name, to: name, wanted: s.name, othersDismissed: others.length },
    });
    return namedMessage("Approved.", s.name, name);
  });
};

export const nameDismiss: Handler = async (caretakerId, body) => {
  const suggestionId = reqUuid(body, "suggestionId", "The suggestion");
  return withColonyLock(async (tx) => {
    const s = await loadPendingSuggestion(tx, suggestionId);
    await tx.update(nameSuggestions).set({ status: "dismissed", decidedBy: caretakerId, decidedAt: new Date() }).where(eq(nameSuggestions.id, s.id));
    await audit(tx, {
      action: NAME_DISMISSED,
      caretakerId,
      reason: "A caretaker closed a name suggestion.",
      inputs: { catId: s.catId, suggestionId: s.id },
    });
    return "Dismissed.";
  });
};

/** A caretaker types the name. It counts as a caretaker-set name, so the finder can no longer ask for another. */
export const catRename: Handler = async (caretakerId, body) => {
  const catId = reqUuid(body, "catId", "The cat");
  const parsed = parseCatName(body.name);
  if (!parsed.ok) throw new Refusal(400, parsed.message);
  return withColonyLock(async (tx) => {
    const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
    if (!cat) throw new Refusal(404, "There is no such cat.");
    const name = await uniqueName(tx, parsed.name, cat.id);
    await tx.update(cats).set({ name, nameLocked: true }).where(eq(cats.id, catId));
    await audit(tx, {
      action: NAME_SET,
      caretakerId,
      reason: "A caretaker set a cat's name.",
      inputs: { catId, from: cat.name, to: name, wanted: parsed.name },
    });
    return namedMessage("Saved.", parsed.name, name);
  });
};

const MONEY_MOVED =
  "This cat already has money set aside or a payout on record, so it cannot be marked as already neutered. If it really was, ask a developer to settle the money first.";
const IN_FLOW = "This cat is already in the funding steps, so its ear-tip cannot be changed here.";

export const catSetEarTip: Handler = async (caretakerId, body) => {
  const catId = reqUuid(body, "catId", "The cat");
  const earTip = body.earTip;
  if (earTip !== "present" && earTip !== "absent") throw new Refusal(400, "Say whether the ear-tip is present or absent.");

  return withColonyLock(async (tx) => {
    const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
    if (!cat) throw new Refusal(404, "There is no such cat.");
    const status = cat.status as CatStatus;
    // A caretaker's decision answers any open question about this cat's ear-tip.
    const endReviews = async () => {
      await resolveReviewBySubject(tx, disagreementSubject(catId), caretakerId, "Decided by a caretaker.");
      await resolveReviewBySubject(tx, lateYesSubject(catId), caretakerId, "Decided by a caretaker.");
    };
    const note = async (message: string, change: string) => {
      await audit(tx, {
        action: "cat_updated",
        caretakerId,
        reason: "A caretaker updated a cat's card.",
        inputs: { catId, earTip, change, from: status },
      });
      await endReviews();
      return message;
    };

    if (earTip === "present") {
      if (cat.earTipped === true) {
        await endReviews();
        return "Already marked as ear-tipped.";
      }
      if (status === "spotted" || status === "queued") {
        try {
          await markAlreadyNeutered(tx, catId);
        } catch (e) {
          if (e instanceof MoneyAlreadyMoved) throw new Refusal(409, MONEY_MOVED);
          throw e;
        }
        return note("Marked as ear-tipped, so already neutered.", "already_neutered");
      }
      if (status === "neutered" || status === "adoptable" || status === "adopted") {
        await tx.update(cats).set({ earTipped: true }).where(eq(cats.id, catId));
        return note("Marked as ear-tipped.", "ear_tip_only");
      }
      throw new Refusal(409, IN_FLOW);
    }

    if (status === "queued" && cat.earTipped === false) {
      await endReviews();
      return "Already marked as not ear-tipped.";
    }
    if (status !== "spotted") throw new Refusal(409, IN_FLOW);
    await tx.update(cats).set({ earTipped: false, queuedAt: new Date() }).where(eq(cats.id, catId));
    await transitionCat(tx, catId, "queued");
    await tx.insert(wakeups).values({ kind: "cat_queued", payload: { catId } });
    return note("Marked as not ear-tipped. The cat joins the queue for funding.", "queued");
  });
};

/**
 * Takes a wrong "already neutered" call back: the cat returns to the queue. Allowed only for a cat that is
 * marked neutered with no neuter treatment, no allocation and no payout, checked under the lock that every
 * cat action uses. The Yes answers that caused the call are removed, so they stop counting anywhere; an
 * answer given afterwards is a new answer and files a review like any late Yes.
 */
export const catUndoNeutered: Handler = async (caretakerId, body) => {
  const catId = reqUuid(body, "catId", "The cat");
  return withColonyLock(async (tx) => {
    const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
    if (!cat) throw new Refusal(404, "There is no such cat.");
    if (cat.status !== "neutered") throw new Refusal(409, "Only a cat marked neutered can be put back in the queue.");
    const [treated] = await tx.select({ id: treatments.id }).from(treatments).where(and(eq(treatments.catId, catId), eq(treatments.type, "neuter"))).limit(1);
    const [allocated] = await tx.select({ id: allocations.id }).from(allocations).where(eq(allocations.catId, catId)).limit(1);
    const [paid] = await tx.select({ id: payouts.id }).from(payouts).where(eq(payouts.catId, catId)).limit(1);
    if (treated || allocated || paid) {
      throw new Refusal(409, "This cat has a vet record, money set aside or a payout, so it cannot be put back in the queue.");
    }

    const cleared = await tx.delete(earTipFlags).where(and(eq(earTipFlags.catId, catId), eq(earTipFlags.value, "yes"))).returning({ id: earTipFlags.id });
    await tx.update(cats).set({ earTipped: false, queuedAt: new Date() }).where(eq(cats.id, catId));
    await transitionCat(tx, catId, "queued");
    await enqueueWakeup(tx, "cat_queued", { catId });
    await audit(tx, {
      action: "cat_updated",
      caretakerId,
      reason: "A caretaker updated a cat's card.",
      inputs: { catId, change: "neutered_undone", from: "neutered", yesAnswersCleared: cleared.length },
    });
    return "Put back in the queue. The earlier ear-tip answers no longer count.";
  });
};

function lifecycle(to: "adoptable" | "adopted", from: CatStatus, refusal: string, done: string): Handler {
  return async (caretakerId, body) => {
    const catId = reqUuid(body, "catId", "The cat");
    return withColonyLock(async (tx) => {
      const [cat] = await tx.select({ status: cats.status }).from(cats).where(eq(cats.id, catId));
      if (!cat) throw new Refusal(404, "There is no such cat.");
      if (cat.status === to) return done;
      try {
        await transitionCat(tx, catId, to);
      } catch (e) {
        if (e instanceof IllegalTransition) throw new Refusal(409, refusal);
        throw e;
      }
      await audit(tx, {
        action: "cat_updated",
        caretakerId,
        reason: "A caretaker updated a cat's card.",
        inputs: { catId, change: to, from },
      });
      return done;
    });
  };
}

export const catAdoptable = lifecycle("adoptable", "neutered", "Only a neutered cat can be marked ready for a home.", "Marked ready for a home.");
export const catAdopted = lifecycle("adopted", "adoptable", "Only a cat that is ready for a home can be marked adopted.", "Marked adopted.");

// ---------- Photos ----------

/** Stored regions when there are any. With none, a tick says nobody could read a sign or plate. */
export const photoPublish: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  const [s] = await withColonyLock((tx) => tx.select().from(sightings).where(eq(sightings.id, sightingId)));
  if (!s) throw new Refusal(404, "There is no such sighting.");
  if (s.state === "pending" || s.state === "rejected") throw new Refusal(409, "This sighting has no photo that can be published.");
  if (s.publicReady) throw new Refusal(409, "This photo is already public.");

  const stored = (s.assessment as { sensitive_regions?: unknown } | null)?.sensitive_regions;
  const regions: Box[] = Array.isArray(stored) ? (stored as Box[]) : [];
  if (regions.length === 0 && !flag(body, "noSensitive")) {
    throw new Refusal(400, "Tick the box to confirm no house numbers, signs or plates are visible. Without it the photo stays private.");
  }

  let key: string;
  try {
    key = (await publishScrubbed(s.originalKey, regions)).key;
  } catch (e) {
    if (e instanceof StoredObjectMissing) throw new Refusal(409, "The original photo is missing, so it cannot be published.");
    throw e;
  }
  return withColonyLock(async (tx) => {
    const moved = await tx
      .update(sightings)
      .set({ publicKey: key, publicReady: true })
      .where(and(eq(sightings.id, sightingId), eq(sightings.publicReady, false)))
      .returning({ id: sightings.id });
    if (moved.length === 0) throw new Refusal(409, "This photo is already public.");
    await audit(tx, {
      action: "photo_published",
      caretakerId,
      reason: "A caretaker published a photo.",
      inputs: { sightingId, catId: s.catId, regions: regions.length, confirmedNoSensitive: regions.length === 0 },
    });
    return "Published, with the marked areas blurred.";
  });
};

export const photoHold: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  return withColonyLock(async (tx) => {
    const moved = await tx
      .update(sightings)
      .set({ publicReady: false, publicKey: null })
      .where(and(eq(sightings.id, sightingId), eq(sightings.publicReady, true)))
      .returning({ id: sightings.id, catId: sightings.catId });
    if (moved.length === 0) throw new Refusal(409, "This photo is not public.");
    await audit(tx, {
      action: "photo_held",
      caretakerId,
      reason: "A caretaker held back a photo.",
      inputs: { sightingId, catId: moved[0].catId },
    });
    return "Held back. It no longer shows on any public page.";
  });
};

// ---------- Wakeups the agent gave up on ----------

function moveFailed(to: "pending" | "done", done: string): Handler {
  return async (_caretakerId, body) => {
    const wakeupId = reqUuid(body, "wakeupId", "The wakeup");
    const moved = await withColonyLock((tx) =>
      tx
        .update(wakeups)
        .set(to === "pending" ? { status: "pending", attempts: 0, claimedAt: null, runAfter: sql`now()` } : { status: "done" })
        .where(and(eq(wakeups.id, wakeupId), eq(wakeups.status, "failed")))
        .returning({ id: wakeups.id }),
    );
    if (moved.length === 0) throw new Refusal(409, "This job is no longer marked as failed.");
    return done;
  };
}

export const wakeupRetry = moveFailed("pending", "Queued again. The treasurer will try it shortly.");
export const wakeupDismiss = moveFailed("done", "Dismissed.");
