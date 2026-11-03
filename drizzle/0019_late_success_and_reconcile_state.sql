ALTER TABLE "donations" ADD COLUMN "reconcile_state" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "late_success_review_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_late_success_review_id_review_requests_id_fk" FOREIGN KEY ("late_success_review_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;