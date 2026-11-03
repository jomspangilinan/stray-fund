ALTER TABLE "payouts" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "last_attempt_at" timestamp with time zone;