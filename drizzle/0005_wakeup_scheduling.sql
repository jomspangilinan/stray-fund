ALTER TABLE "wakeups" ADD COLUMN "run_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "wakeups" ADD COLUMN "claimed_at" timestamp with time zone;