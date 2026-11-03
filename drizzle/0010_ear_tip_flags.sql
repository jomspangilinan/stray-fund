CREATE TABLE "ear_tip_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ear_tip_flags_value_check" CHECK ("ear_tip_flags"."value" in ('yes', 'no'))
);
--> statement-breakpoint
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_verification_check";--> statement-breakpoint
DROP INDEX "receipts_booking_live_idx";--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "requested_ear_tip" text;--> statement-breakpoint
ALTER TABLE "ear_tip_flags" ADD CONSTRAINT "ear_tip_flags_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ear_tip_flags" ADD CONSTRAINT "ear_tip_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ear_tip_flags_cat_user_idx" ON "ear_tip_flags" USING btree ("cat_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_booking_live_idx" ON "receipts" USING btree ("booking_id") WHERE "receipts"."verification" in ('pending', 'verified', 'awaiting_ear_tip_confirmation');--> statement-breakpoint
ALTER TABLE "guardrails" DROP COLUMN "ear_tip_confidence_min";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "ear_tip_result";--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_verification_check" CHECK ("receipts"."verification" in ('pending', 'verified', 'rejected', 'needs_review', 'awaiting_ear_tip_confirmation'));--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_requested_ear_tip_check" CHECK ("sightings"."requested_ear_tip" in ('yes', 'no'));--> statement-breakpoint
-- Data: the AI no longer judges ear tips, so its words leave stored rows.
UPDATE "sightings" SET "state" = 'new_cat', "assessment" = "assessment" - 'review_reason' WHERE "state" = 'needs_review' AND "assessment"->>'review_reason' = 'ear_tip' AND "cat_id" IS NOT NULL;--> statement-breakpoint
UPDATE "sightings" SET "state" = 'matched', "assessment" = "assessment" - 'review_reason' WHERE "state" = 'needs_review' AND "assessment"->>'review_reason' = 'ear_tip_changed' AND "cat_id" IS NOT NULL;--> statement-breakpoint
UPDATE "sightings" SET "assessment" = "assessment" - 'ear_tip' - 'ear_tip_confidence' WHERE "assessment" IS NOT NULL;--> statement-breakpoint
UPDATE "receipts" SET "verification" = 'awaiting_ear_tip_confirmation', "reasons" = '{}' WHERE "verification" = 'needs_review' AND "reasons" <> '{}' AND "reasons" <@ array['ear_tip_unreadable', 'ear_tip_not_confirmed', 'ear_tip_low_confidence', 'not_same_cat', 'no_reference_photos'] AND "ear_tip_photo_key" IS NOT NULL;--> statement-breakpoint
UPDATE "receipts" SET "reasons" = array_remove(array_remove(array_remove(array_remove(array_remove("reasons", 'ear_tip_unreadable'), 'ear_tip_not_confirmed'), 'ear_tip_low_confidence'), 'not_same_cat'), 'no_reference_photos');
