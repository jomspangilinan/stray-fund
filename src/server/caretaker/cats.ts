import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { insertNewCat, publishPhoto } from "../spot";
import { resolveReviewBySubject } from "../agent/review";
import { disagreementSubject, lateYesSubject } from "../earTipFlags";
import { IllegalTransition, MoneyAlreadyMoved, markAlreadyNeutered, transitionCat } from "../catTransitions";
import { parseCatBox } from "@/lib/keepsake";
import { AssessmentSchema } from "../ai/schemas";
import { withColonyLock, type Tx } from "../db/client";
import { agentActions, allocations, bookings, catPriority, cats, earTipFlags, milestoneSeen, nameSuggestions, payouts, reports, sightings, treatments, wakeups } from "../db/schema";
import { uniqueName } from "../catNames";
import { EAR_TIP_ANSWERED, NAME_ANOTHER, NAME_APPROVED, NAME_DISMISSED, NAME_SET, NAME_SUGGESTED, SEX_ANSWERED } from "../privateActions";
import { parseCatName } from "@/lib/catNames";
import { publishCatOnly, type Box } from "../photos";
import { getStorage, removePublicCopy, StoredObjectMissing } from "../storage";
import sharp from "sharp";
import { rotateBox, type Turn } from "@/lib/rotation";
import { attachReports, confirmOpenClaim, dismissCatlessReports, fileStaffReport, HOLD_CLAIMS } from "../reports";
import { enqueueWakeup } from "../wakeups";
import { autoPublishable, needsHumanTick, regionsOf } from "../photoGate";
import { audit, flag, reqUuid, Refusal, type Handler } from "./shared";
import { isSampleSightingKey } from "../demoPrivacy";
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
  // Same rule as a fresh photo: a person confirming the cat has not checked the picture for signs or plates.
  if (!autoPublishable(s.assessment)) return;
  await publishPhoto(s.id, s.originalKey, regionsOf(s.assessment));
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
    await attachReports(tx, s.id, catId);
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
    await attachReports(tx, s.id, catId);
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
    await dismissCatlessReports(tx, s.id, caretakerId);
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
    // A confirmed hold ends with a vet's word, never with an unticked box, so nothing below runs if one is in the way.
    for (const claim of HOLD_CLAIMS) {
      if (!cat.flags.includes(claim) || flags.includes(claim)) continue;
      const [confirmed] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(and(eq(reports.catId, catId), eq(reports.claim, claim), eq(reports.status, "confirmed")))
        .limit(1);
      if (confirmed) throw new Refusal(409, "A vet clears this. Ask the vet to check.");
    }
    await tx.update(cats).set({ sex, sexUnconfirmed: false, flags }).where(eq(cats.id, catId));
    // A flag newly set confirms the open reports for it, so the desk shows one card, and files a confirmed caretaker
    // report only when there were none.
    for (const claim of HOLD_CLAIMS) {
      if (flags.includes(claim) && !cat.flags.includes(claim)) {
        if ((await confirmOpenClaim(tx, catId, claim, caretakerId)) === 0) {
          await fileStaffReport(tx, { catId, claim, source: "caretaker", reporterId: caretakerId });
        }
      }
    }
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
    // The cat has its name now, so the waiting ideas for it are closed.
    const closed = await tx
      .update(nameSuggestions)
      .set({ status: "dismissed", decidedBy: caretakerId, decidedAt: new Date() })
      .where(and(eq(nameSuggestions.catId, catId), eq(nameSuggestions.status, "pending")))
      .returning({ id: nameSuggestions.id });
    await audit(tx, {
      action: NAME_SET,
      caretakerId,
      reason: "A caretaker set a cat's name.",
      inputs: { catId, from: cat.name, to: name, wanted: parsed.name, othersDismissed: closed.length },
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
      if (cat.neuteredUnconfirmed) {
        // Neighbours already moved this cat. A caretaker saying the same thing is what confirms it.
        await tx.update(cats).set({ neuteredUnconfirmed: false }).where(eq(cats.id, catId));
        return note("Confirmed as ear-tipped, so already neutered.", "neutered_confirmed");
      }
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
    if (status === "neutered" || status === "adoptable" || status === "adopted") {
      // A vet may neuter without tipping the ear. The record changes; the cat stays neutered.
      await tx.update(cats).set({ earTipped: false }).where(eq(cats.id, catId));
      return note("Marked as not ear-tipped. The cat stays neutered.", "ear_tip_only");
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
    await tx.update(cats).set({ earTipped: false, neuteredUnconfirmed: false, queuedAt: new Date() }).where(eq(cats.id, catId));
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

function lifecycle(to: "adoptable" | "adopted" | "neutered", from: CatStatus, refusal: string, done: string): Handler {
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
      // A caretaker who marks a cat ready for a home has settled that it is neutered.
      await tx.update(cats).set({ neuteredUnconfirmed: false }).where(eq(cats.id, catId));
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
/** Undo for a wrong home step. No money hangs off these stages. */
export const catNotAdopted = lifecycle("adoptable", "adopted", "Only an adopted cat can go back to ready for a home.", "Back to ready for a home.");
export const catNotAdoptable = lifecycle("neutered", "adoptable", "Only a cat that is ready for a home can go back to neutered.", "Back to neutered, not ready for a home yet.");

// ---------- Photos ----------

/** Stored regions when there are any. With none, a tick says nobody could read a sign or plate. */
export const photoPublish: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  const [s] = await withColonyLock((tx) => tx.select().from(sightings).where(eq(sightings.id, sightingId)));
  if (!s) throw new Refusal(404, "There is no such sighting.");
  if (isSampleSightingKey(s.originalKey)) throw new Refusal(409, "This is a sample drawing, not a photo, so it can't be published.");
  if (s.state === "pending" || s.state === "rejected") throw new Refusal(409, "This sighting has no photo that can be published.");
  if (s.publicReady) throw new Refusal(409, "This photo is already public.");

  const regions: Box[] = regionsOf(s.assessment);
  if (needsHumanTick(s.assessment) && !flag(body, "noSensitive")) {
    throw new Refusal(400, "Tick the box to confirm no house numbers, signs or plates are visible. Without it the photo stays private.");
  }

  let key: string;
  try {
    key = (await publishCatOnly(s.originalKey, { box: parseCatBox(s.catBox), mask: null }, regions)).key;
  } catch (e) {
    if (e instanceof StoredObjectMissing) throw new Refusal(409, "The original photo is missing, so it cannot be published.");
    throw e;
  }
  try {
    return await withColonyLock(async (tx) => {
    const moved = await tx
      .update(sightings)
      // A plain photo still waiting for the worker is settled here, so the worker never overwrites this copy.
      .set({ publicKey: key, publicReady: true, ...(s.needsDevelop ? { developedAt: sql`coalesce(${sightings.developedAt}, now())` } : {}) })
      // The copy was cut from the original as it was when s was read: a rotation since then makes it the wrong way round.
      .where(and(eq(sightings.id, sightingId), eq(sightings.publicReady, false), eq(sightings.photoVersion, s.photoVersion)))
      .returning({ id: sightings.id });
    if (moved.length === 0) {
      const [now] = await tx.select({ publicReady: sightings.publicReady }).from(sightings).where(eq(sightings.id, sightingId));
      if (!now) throw new Refusal(404, "There is no such sighting.");
      if (now.publicReady) throw new Refusal(409, "This photo is already public.");
      throw new Refusal(409, "The photo was rotated while it was being published. Try again.");
    }
    await audit(tx, {
      action: "photo_published",
      caretakerId,
      reason: "A caretaker published a photo.",
      inputs: { sightingId, catId: s.catId, regions: regions.length, confirmedNoSensitive: regions.length === 0 },
    });
    return "Published with only the cat sharp.";
    });
  } catch (e) {
    // The copy just made is not the sighting's public copy (someone else published first, or the audit failed): do not leave it readable.
    await removePublicCopy(key);
    throw e;
  }
};

export const photoHold: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  const droppedKey = await withColonyLock(async (tx) => {
    const [before] = await tx.select().from(sightings).where(eq(sightings.id, sightingId)).for("update");
    // A public no-AI photo still waiting for the worker is held too, so the worker never publishes it later.
    const waiting = !!before && before.needsDevelop && before.developedAt === null;
    if (!before || (!before.publicReady && !waiting)) throw new Refusal(409, "This photo is not public.");
    await tx
      .update(sightings)
      .set({ publicReady: false, publicKey: null, ...(waiting ? { developedAt: new Date() } : {}) })
      .where(eq(sightings.id, sightingId));
    await audit(tx, {
      action: "photo_held",
      caretakerId,
      reason: "A caretaker held back a photo.",
      inputs: { sightingId, catId: before.catId },
    });
    return before.publicKey;
  });
  // The hold has committed. Only now is the public copy deleted, and a failed delete never undoes the hold.
  await removePublicCopy(droppedKey);
  return "Held back. It no longer shows on any public page.";
};

/**
 * Turns the private original a quarter turn in place (same key) and turns the stored cat box and marked areas with it.
 * A public photo gets a new cat-only copy with the soft circle round the turned box (the stored cut-out is gone) and
 * the old public copy is deleted after the commit. A photo still waiting for the worker needs nothing more: the
 * worker develops the turned original. The cat's avatar does not change.
 */
export const photoRotate: Handler = async (caretakerId, body) => {
  const sightingId = reqUuid(body, "sightingId", "The sighting");
  const direction = body.direction;
  if (direction !== "left" && direction !== "right") throw new Refusal(400, "The direction must be left or right.");
  const turn: Turn = direction === "right" ? 90 : 270;

  const result = await withColonyLock(async (tx) => {
    const [s] = await tx.select().from(sightings).where(eq(sightings.id, sightingId)).for("update");
    if (!s) throw new Refusal(404, "There is no such sighting.");
    const storage = getStorage();
    let original: Buffer;
    try {
      original = await storage.getPrivate(s.originalKey);
    } catch (e) {
      if (e instanceof StoredObjectMissing) throw new Refusal(409, "The original photo is missing, so it cannot be rotated.");
      throw e;
    }
    const turned = await sharp(original).rotate(turn).jpeg({ quality: 85 }).toBuffer();
    await storage.putPrivate(s.originalKey, turned, "image/jpeg");
    let newKey: string | null = null;
    try {
      const oldBox = parseCatBox(s.catBox);
      const catBox = oldBox ? rotateBox(oldBox, turn) : null;
      const a = s.assessment as { sensitive_regions?: unknown } | null;
      const assessment =
        a && Array.isArray(a.sensitive_regions) ? { ...a, sensitive_regions: (a.sensitive_regions as Box[]).map((r) => rotateBox(r, turn)) } : s.assessment;
      const patch: Partial<typeof sightings.$inferInsert> = { catBox, assessment: assessment as object | null, photoVersion: sql`${sightings.photoVersion} + 1` as unknown as number };
      if (s.publicReady) {
        newKey = (await publishCatOnly(s.originalKey, { box: catBox, mask: null }, regionsOf(assessment))).key;
        patch.publicKey = newKey;
      }
      await tx.update(sightings).set(patch).where(eq(sightings.id, sightingId));
      await audit(tx, {
        action: "photo_rotated",
        caretakerId,
        reason: "A caretaker rotated a photo.",
        inputs: { sightingId, catId: s.catId, direction },
      });
    } catch (e) {
      // The transaction rolls back, so put the original and the public copy back as they were.
      await storage.putPrivate(s.originalKey, original, "image/jpeg").catch(() => {});
      await removePublicCopy(newKey);
      throw e;
    }
    return { oldKey: s.publicReady ? s.publicKey : null };
  });
  // The rotation has committed. Only now is the old public copy deleted, and a failed delete never undoes it.
  await removePublicCopy(result.oldKey);
  return "Rotated.";
};

export const CAT_HAS_HISTORY = "This cat has history. Hold its photos instead.";

/**
 * Audit rows that may name a removable cat: neighbours' votes and name ideas, the caretaker's decisions on those
 * names, and the photo actions. Any other action about the cat (funding, ordering, reports, card edits) is history.
 */
const REMOVABLE_WITH: readonly string[] = [
  EAR_TIP_ANSWERED,
  SEX_ANSWERED,
  NAME_SUGGESTED,
  NAME_ANOTHER,
  NAME_APPROVED,
  NAME_DISMISSED,
  NAME_SET,
  "photo_published",
  "photo_held",
  "photo_rotated",
];

/**
 * Locks a cat that a public no-AI photo made by mistake, and its sightings, or refuses with `refusal` (409). Allowed
 * only for a spotted cat whose every sighting is a plain public photo and that nothing else refers to: no money,
 * booking, vet record, report, place in the order, celebration or agent action. Votes, name ideas and ear-tip flags
 * are the only things allowed to name it. 404 when there is no such cat.
 */
async function loadRemovable(tx: Tx, catId: string, refusal: string): Promise<{ cat: typeof cats.$inferSelect; shots: Sighting[] }> {
  const [cat] = await tx.select().from(cats).where(eq(cats.id, catId)).for("update");
  if (!cat) throw new Refusal(404, "There is no such cat.");
  const shots = await tx.select().from(sightings).where(eq(sightings.catId, catId)).for("update");
  if (cat.status !== "spotted" || shots.length === 0 || shots.some((s) => !s.needsDevelop)) throw new Refusal(409, refusal);

  const shotIds = shots.map((s) => s.id);
  const one = async (q: Promise<unknown[]>) => (await q).length > 0;
  const referenced =
    (await one(tx.select({ id: allocations.id }).from(allocations).where(eq(allocations.catId, catId)).limit(1))) ||
    (await one(tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.catId, catId)).limit(1))) ||
    (await one(tx.select({ id: payouts.id }).from(payouts).where(eq(payouts.catId, catId)).limit(1))) ||
    (await one(tx.select({ id: treatments.id }).from(treatments).where(eq(treatments.catId, catId)).limit(1))) ||
    (await one(tx.select({ id: reports.id }).from(reports).where(or(eq(reports.catId, catId), inArray(reports.sightingId, shotIds))).limit(1))) ||
    (await one(
      tx
        .select({ id: catPriority.catId })
        .from(catPriority)
        .where(or(eq(catPriority.catId, catId), eq(catPriority.beforeCatId, catId), sql`${catId}::uuid = any(${catPriority.passedCatIds})`))
        .limit(1),
    )) ||
    (await one(tx.select({ id: milestoneSeen.catId }).from(milestoneSeen).where(eq(milestoneSeen.catId, catId)).limit(1))) ||
    (await one(
      tx
        .select({ id: agentActions.id })
        .from(agentActions)
        .where(and(sql`${agentActions.inputs}->>'catId' = ${catId}`, notInArray(agentActions.action, [...REMOVABLE_WITH])))
        .limit(1),
    ));
  if (referenced) throw new Refusal(409, refusal);
  return { cat, shots };
}

/** Drops what may name a removable cat: its ear-tip answers, name ideas and open ear-tip questions (its sex answer lives on the cat row). */
async function clearRemovable(tx: Tx, catId: string, caretakerId: string, why: string): Promise<void> {
  await tx.delete(earTipFlags).where(eq(earTipFlags.catId, catId));
  await tx.delete(nameSuggestions).where(eq(nameSuggestions.catId, catId));
  // An ear-tip question about a cat that no longer exists has nothing left to decide.
  await resolveReviewBySubject(tx, disagreementSubject(catId), caretakerId, why);
  await resolveReviewBySubject(tx, lateYesSubject(catId), caretakerId, why);
}

/**
 * Removes a cat that a public no-AI photo made by mistake (D4, R21), under the rules of loadRemovable. Otherwise 409.
 * The public copies are deleted after the commit. The private originals stay: the app has no permission to delete
 * from the private bucket.
 */
export const catRemove: Handler = async (caretakerId, body) => {
  const catId = reqUuid(body, "catId", "The cat");
  const publicKeys = await withColonyLock(async (tx) => {
    const { cat, shots } = await loadRemovable(tx, catId, CAT_HAS_HISTORY);
    const shotIds = shots.map((s) => s.id);
    await clearRemovable(tx, catId, caretakerId, "The cat was removed.");
    await tx.delete(sightings).where(eq(sightings.catId, catId));
    await tx.delete(cats).where(eq(cats.id, catId));
    // Audit rows name cats by id in inputs, with no foreign key, so this one outlives the cat. The name is kept for the record.
    await audit(tx, {
      action: "cat_removed",
      caretakerId,
      reason: "A caretaker removed a cat that was added by mistake.",
      inputs: { catId, name: cat.name, sightingIds: shotIds },
    });
    return shots.map((s) => s.publicKey).filter((k): k is string => !!k);
  });
  // The removal has committed. Only now are the public copies deleted, and a failed delete never undoes it.
  for (const key of publicKeys) await removePublicCopy(key);
  return "Removed. The cat and its photos no longer show on any public page.";
};

export const CAT_MERGE_HAS_HISTORY = "This cat has history, so it can't be moved into another cat.";

/**
 * "Same cat as…": a public no-AI photo made a second card for a cat we already know. The duplicate must pass the
 * same rules as cat_remove. Its photos move to the real cat as matched sightings and stay published, so they show on
 * the real cat's page with no storage change. Its votes, name ideas and ear-tip flags go, and so does the duplicate.
 */
export const catMerge: Handler = async (caretakerId, body) => {
  const catId = reqUuid(body, "catId", "The cat");
  const intoCatId = reqUuid(body, "intoCatId", "The cat to move it into");
  if (catId === intoCatId) throw new Refusal(409, "A cat can't be the same cat as itself. Choose another cat.");
  const into = await withColonyLock(async (tx) => {
    const { cat, shots } = await loadRemovable(tx, catId, CAT_MERGE_HAS_HISTORY);
    const [target] = await tx.select({ id: cats.id, name: cats.name }).from(cats).where(eq(cats.id, intoCatId)).for("update");
    if (!target) throw new Refusal(404, "There is no such cat to move it into.");
    const shotIds = shots.map((s) => s.id);
    await tx.update(sightings).set({ catId: target.id, state: "matched" }).where(eq(sightings.catId, catId));
    await clearRemovable(tx, catId, caretakerId, "The cat was merged into another.");
    await tx.delete(cats).where(eq(cats.id, catId));
    // Like cat_removed: catId is the cat that is gone, named by id with no foreign key. The real cat goes under
    // intoCatId, so this row never counts as history against it.
    await audit(tx, {
      action: "cat_merged",
      caretakerId,
      reason: "A caretaker found a cat added twice and moved its photos to the one already known.",
      inputs: { catId, name: cat.name, intoCatId: target.id, intoName: target.name, sightingIds: shotIds },
    });
    return target;
  });
  return `Moved. ${into.name} now has these photos, and the second card is gone.`;
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
