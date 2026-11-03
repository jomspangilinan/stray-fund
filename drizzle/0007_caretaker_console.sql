ALTER TABLE "review_requests" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;