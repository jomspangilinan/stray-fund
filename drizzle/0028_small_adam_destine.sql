ALTER TABLE "sightings" ADD COLUMN "needs_develop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "developed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "develop_attempts" integer DEFAULT 0 NOT NULL;