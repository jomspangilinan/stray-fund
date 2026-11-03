CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"inputs" jsonb,
	"reason" text NOT NULL,
	"amount" integer,
	"status" text NOT NULL,
	"approved_by" uuid,
	"paypal_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donation_id" uuid NOT NULL,
	"cat_id" uuid,
	"purpose" text NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allowed_payees" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid NOT NULL,
	"vet_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone,
	"package_price" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_price_check" CHECK ("bookings"."package_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sex" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'spotted' NOT NULL,
	"ear_tipped" boolean,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"coat" jsonb,
	"coat_pattern" text,
	"area_name" text NOT NULL,
	"exact_lat" double precision,
	"exact_lng" double precision,
	"fuzzed_lat" double precision,
	"fuzzed_lng" double precision,
	"bio" text,
	"queued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cats_sex_check" CHECK ("cats"."sex" in ('female', 'male', 'unknown')),
	CONSTRAINT "cats_status_check" CHECK ("cats"."status" in ('spotted', 'queued', 'funded', 'booked', 'in_care', 'neutered', 'adoptable', 'adopted')),
	CONSTRAINT "cats_flags_check" CHECK ("cats"."flags" <@ array['pregnant', 'injured', 'sick', 'kitten'])
);
--> statement-breakpoint
CREATE TABLE "donations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"gross" integer NOT NULL,
	"paypal_fee" integer DEFAULT 0 NOT NULL,
	"net" integer NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"paypal_order_id" text NOT NULL,
	"paypal_capture_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donations_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "donations_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "donations_gross_check" CHECK ("donations"."gross" >= 0),
	CONSTRAINT "donations_fee_check" CHECK ("donations"."paypal_fee" >= 0),
	CONSTRAINT "donations_net_check" CHECK ("donations"."net" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guardrails" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"package_price" integer DEFAULT 150000 NOT NULL,
	"deposit_pct" integer DEFAULT 30 NOT NULL,
	"max_per_cat" integer DEFAULT 250000 NOT NULL,
	"max_per_day" integer DEFAULT 1000000 NOT NULL,
	"approval_threshold" integer DEFAULT 200000 NOT NULL,
	"ear_tip_confidence_min" numeric(3, 2) DEFAULT 0.8 NOT NULL,
	"match_confidence_min" numeric(3, 2) DEFAULT 0.8 NOT NULL,
	CONSTRAINT "guardrails_singleton_check" CHECK ("guardrails"."id" = 1),
	CONSTRAINT "guardrails_deposit_pct_check" CHECK ("guardrails"."deposit_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"payee_user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"fee" integer,
	"kind" text NOT NULL,
	"paypal_payout_batch_id" text,
	"paypal_item_id" text,
	"receipt_id" uuid,
	"action_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amount_check" CHECK ("payouts"."amount" >= 0),
	CONSTRAINT "payouts_kind_check" CHECK ("payouts"."kind" in ('deposit', 'balance')),
	CONSTRAINT "payouts_status_check" CHECK ("payouts"."status" in ('awaiting_approval', 'queued', 'sent', 'succeeded', 'failed', 'needs_review', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"sha256" text NOT NULL,
	"parsed" jsonb,
	"ear_tip_photo_key" text,
	"ear_tip_result" jsonb,
	"verification" text DEFAULT 'pending' NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "receipts_verification_check" CHECK ("receipts"."verification" in ('pending', 'verified', 'rejected', 'needs_review'))
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid,
	"original_key" text NOT NULL,
	"public_key" text,
	"public_ready" boolean DEFAULT false NOT NULL,
	"taken_at" timestamp with time zone,
	"caught_by_user_id" uuid,
	"match_confidence" double precision,
	"assessment" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sightings_state_check" CHECK ("sightings"."state" in ('pending', 'matched', 'new_cat', 'needs_review', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "treatments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid NOT NULL,
	"type" text NOT NULL,
	"product" text,
	"date" date NOT NULL,
	"next_due" date,
	"vet_id" uuid,
	"receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatments_type_check" CHECK ("treatments"."type" in ('neuter', 'vaccine', 'deworming'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"role" text NOT NULL,
	"paypal_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('donor', 'caretaker', 'vet', 'foster'))
);
--> statement-breakpoint
CREATE TABLE "wakeups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wakeups_status_check" CHECK ("wakeups"."status" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"paypal_event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_donation_id_donations_id_fk" FOREIGN KEY ("donation_id") REFERENCES "public"."donations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowed_payees" ADD CONSTRAINT "allowed_payees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vet_id_users_id_fk" FOREIGN KEY ("vet_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payee_user_id_users_id_fk" FOREIGN KEY ("payee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_action_id_agent_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."agent_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_caught_by_user_id_users_id_fk" FOREIGN KEY ("caught_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatments" ADD CONSTRAINT "treatments_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatments" ADD CONSTRAINT "treatments_vet_id_users_id_fk" FOREIGN KEY ("vet_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allowed_payees_user_kind_idx" ON "allowed_payees" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_booking_kind_live_idx" ON "payouts" USING btree ("booking_id","kind") WHERE "payouts"."status" not in ('failed', 'rejected');--> statement-breakpoint
CREATE INDEX "wakeups_status_idx" ON "wakeups" USING btree ("status");
--> statement-breakpoint
INSERT INTO "guardrails" ("id") VALUES (1);
