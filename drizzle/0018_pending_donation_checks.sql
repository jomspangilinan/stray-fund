ALTER TABLE "donations" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "donations" ADD COLUMN "reconcile_after" timestamp with time zone;