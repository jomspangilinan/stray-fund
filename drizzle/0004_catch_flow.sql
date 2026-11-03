ALTER TABLE "cats" ADD COLUMN "location_approximate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "exact_lat" double precision;--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "exact_lng" double precision;--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "requested_sex" text;