import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// All money columns are integer centavos.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: id(),
    username: text("username").notNull().unique(),
    role: text("role").notNull(),
    // Private: never exposed through the public ledger or any public API.
    paypalEmail: text("paypal_email"),
    // Vets only. The name printed on this vet's receipts. Private, like the email.
    clinicName: text("clinic_name"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "users_role_check",
      sql`${t.role} in ('donor', 'caretaker', 'vet', 'foster')`,
    ),
    // Usernames are unique ignoring case.
    uniqueIndex("users_username_lower_idx").on(sql`lower(${t.username})`),
  ],
);

export const cats = pgTable(
  "cats",
  {
    id: id(),
    name: text("name").notNull(),
    sex: text("sex").notNull().default("unknown"),
    status: text("status").notNull().default("spotted"),
    earTipped: boolean("ear_tipped"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    coat: jsonb("coat"),
    coatPattern: text("coat_pattern"),
    areaName: text("area_name").notNull(),
    exactLat: doublePrecision("exact_lat"),
    exactLng: doublePrecision("exact_lng"),
    fuzzedLat: doublePrecision("fuzzed_lat"),
    fuzzedLng: doublePrecision("fuzzed_lng"),
    // True when the exact point is the colony centre because the photo carried no location.
    locationApproximate: boolean("location_approximate").notNull().default(false),
    bio: text("bio"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("cats_sex_check", sql`${t.sex} in ('female', 'male', 'unknown')`),
    check(
      "cats_status_check",
      sql`${t.status} in ('spotted', 'queued', 'funded', 'booked', 'in_care', 'neutered', 'adoptable', 'adopted')`,
    ),
    check(
      "cats_flags_check",
      sql`${t.flags} <@ array['pregnant', 'injured', 'sick', 'kitten']`,
    ),
  ],
);

export const sightings = pgTable(
  "sightings",
  {
    id: id(),
    catId: uuid("cat_id").references(() => cats.id),
    originalKey: text("original_key").notNull(),
    publicKey: text("public_key"),
    publicReady: boolean("public_ready").notNull().default(false),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    caughtByUserId: uuid("caught_by_user_id").references(() => users.id),
    matchConfidence: doublePrecision("match_confidence"),
    // Private. Kept so a sighting saved before the AI ran can still be finished later.
    exactLat: doublePrecision("exact_lat"),
    exactLng: doublePrecision("exact_lng"),
    requestedSex: text("requested_sex"),
    assessment: jsonb("assessment"),
    state: text("state").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "sightings_state_check",
      sql`${t.state} in ('pending', 'matched', 'new_cat', 'needs_review', 'rejected')`,
    ),
  ],
);

export const donations = pgTable(
  "donations",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id),
    gross: integer("gross").notNull(),
    paypalFee: integer("paypal_fee").notNull().default(0),
    net: integer("net").notNull(),
    currency: text("currency").notNull().default("PHP"),
    paypalOrderId: text("paypal_order_id").notNull().unique(),
    paypalCaptureId: text("paypal_capture_id").unique(),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("donations_gross_check", sql`${t.gross} >= 0`),
    check("donations_fee_check", sql`${t.paypalFee} >= 0`),
    check("donations_net_check", sql`${t.net} >= 0`),
    // A pending order has no fee or net yet. Every other row must add up.
    check(
      "donations_breakdown_check",
      sql`${t.status} = 'pending' or ${t.gross} = ${t.paypalFee} + ${t.net}`,
    ),
  ],
);

export const allocations = pgTable("allocations", {
  id: id(),
  donationId: uuid("donation_id")
    .notNull()
    .references(() => donations.id),
  catId: uuid("cat_id").references(() => cats.id),
  purpose: text("purpose").notNull(),
  // Negative allowed: returns surplus to the pool.
  amount: integer("amount").notNull(),
  createdAt: createdAt(),
});

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    catId: uuid("cat_id")
      .notNull()
      .references(() => cats.id),
    vetId: uuid("vet_id")
      .notNull()
      .references(() => users.id),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    packagePrice: integer("package_price").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("bookings_price_check", sql`${t.packagePrice} >= 0`),
    // One open booking per cat. A completed booking no longer counts.
    uniqueIndex("bookings_cat_open_idx").on(t.catId).where(sql`${t.status} = 'confirmed'`),
  ],
);

export const agentActions = pgTable("agent_actions", {
  id: id(),
  action: text("action").notNull(),
  inputs: jsonb("inputs"),
  reason: text("reason").notNull(),
  amount: integer("amount"),
  status: text("status").notNull(),
  approvedBy: uuid("approved_by").references(() => users.id),
  paypalRef: text("paypal_ref"),
  createdAt: createdAt(),
});

export const treatments = pgTable(
  "treatments",
  {
    id: id(),
    catId: uuid("cat_id")
      .notNull()
      .references(() => cats.id),
    type: text("type").notNull(),
    product: text("product"),
    date: date("date").notNull(),
    nextDue: date("next_due"),
    vetId: uuid("vet_id").references(() => users.id),
    receiptId: uuid("receipt_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "treatments_type_check",
      sql`${t.type} in ('neuter', 'vaccine', 'deworming')`,
    ),
    // A verified receipt writes each treatment once, however often it is applied.
    uniqueIndex("treatments_receipt_type_idx")
      .on(t.receiptId, t.type)
      .where(sql`${t.receiptId} is not null`),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    fileKey: text("file_key").notNull(),
    sha256: text("sha256").notNull().unique(),
    parsed: jsonb("parsed"),
    earTipPhotoKey: text("ear_tip_photo_key"),
    earTipResult: jsonb("ear_tip_result"),
    verification: text("verification").notNull().default("pending"),
    reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "receipts_verification_check",
      sql`${t.verification} in ('pending', 'verified', 'rejected', 'needs_review')`,
    ),
    // One attempt in progress or accepted per booking. Older attempts stay as history.
    uniqueIndex("receipts_booking_live_idx")
      .on(t.bookingId)
      .where(sql`${t.verification} in ('pending', 'verified')`),
  ],
);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    catId: uuid("cat_id")
      .notNull()
      .references(() => cats.id),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    payeeUserId: uuid("payee_user_id")
      .notNull()
      .references(() => users.id),
    amount: integer("amount").notNull(),
    fee: integer("fee"),
    kind: text("kind").notNull(),
    paypalPayoutBatchId: text("paypal_payout_batch_id"),
    paypalItemId: text("paypal_item_id"),
    receiptId: uuid("receipt_id").references(() => receipts.id),
    actionId: uuid("action_id")
      .notNull()
      .references(() => agentActions.id),
    status: text("status").notNull(),
    // Sends begun, committed before each gateway call. Above 1 means a retry.
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    // Evidence for a person reviewing the payout. Never exposed publicly.
    lastGatewayError: text("last_gateway_error"),
    createdAt: createdAt(),
  },
  (t) => [
    check("payouts_amount_check", sql`${t.amount} >= 0`),
    check("payouts_kind_check", sql`${t.kind} in ('deposit', 'balance')`),
    check(
      "payouts_status_check",
      sql`${t.status} in ('awaiting_approval', 'queued', 'sent', 'succeeded', 'failed', 'needs_review', 'rejected')`,
    ),
    // One live payout per booking and kind; failed or rejected ones may be retried.
    uniqueIndex("payouts_booking_kind_live_idx")
      .on(t.bookingId, t.kind)
      .where(sql`${t.status} not in ('failed', 'rejected')`),
  ],
);

export const guardrails = pgTable(
  "guardrails",
  {
    id: integer("id").primaryKey().default(1),
    packagePrice: integer("package_price").notNull().default(150000),
    depositPct: integer("deposit_pct").notNull().default(30),
    maxPerCat: integer("max_per_cat").notNull().default(250000),
    maxPerDay: integer("max_per_day").notNull().default(1000000),
    approvalThreshold: integer("approval_threshold").notNull().default(200000),
    earTipConfidenceMin: numeric("ear_tip_confidence_min", {
      precision: 3,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0.8),
    matchConfidenceMin: numeric("match_confidence_min", {
      precision: 3,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0.8),
  },
  (t) => [
    // Singleton: only one row can ever exist.
    check("guardrails_singleton_check", sql`${t.id} = 1`),
    check("guardrails_deposit_pct_check", sql`${t.depositPct} between 0 and 100`),
  ],
);

export const allowedPayees = pgTable(
  "allowed_payees",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
  },
  (t) => [uniqueIndex("allowed_payees_user_kind_idx").on(t.userId, t.kind)],
);

export const wakeups = pgTable(
  "wakeups",
  {
    id: id(),
    kind: text("kind").notNull(),
    payload: jsonb("payload"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // Not claimable before this. Pushed forward by retry backoff.
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    // Set at each claim, so a run abandoned by a crash can be reclaimed.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "wakeups_status_check",
      sql`${t.status} in ('pending', 'running', 'done', 'failed')`,
    ),
    index("wakeups_status_idx").on(t.status),
  ],
);

export const webhookEvents = pgTable("webhook_events", {
  paypalEventId: text("paypal_event_id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const aiUsage = pgTable("ai_usage", {
  day: date("day").primaryKey(),
  calls: integer("calls").notNull().default(0),
});

export const reviewRequests = pgTable("review_requests", {
  id: id(),
  subject: text("subject").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"),
  // Set when a caretaker closes the request. The note is private to caretakers.
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution"),
  createdAt: createdAt(),
});

export const meals = pgTable("meals", {
  id: id(),
  source: text("source").notNull(),
  createdAt: createdAt(),
});

/** A celebration shown once to a donor for a cat they helped. The unique key is what makes it once. */
export const milestoneSeen = pgTable(
  "milestone_seen",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    catId: uuid("cat_id")
      .notNull()
      .references(() => cats.id),
    milestone: text("milestone").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("milestone_seen_key_idx").on(t.userId, t.catId, t.milestone),
    check("milestone_seen_check", sql`${t.milestone} in ('neutered', 'adopted')`),
  ],
);
