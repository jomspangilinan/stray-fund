ALTER TABLE "users" ADD COLUMN "news_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_name_in_thanks" boolean DEFAULT true NOT NULL;