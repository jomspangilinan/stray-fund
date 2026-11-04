CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid,
	"sighting_id" uuid,
	"claim" text NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"reporter_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"check_question" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"sample" boolean DEFAULT false NOT NULL,
	"photo_agrees" boolean,
	"reported_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_claim_check" CHECK ("reports"."claim" in ('injured', 'pregnant', 'sick', 'kitten')),
	CONSTRAINT "reports_source_check" CHECK ("reports"."source" in ('neighbour', 'photo', 'caretaker', 'vet')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('open', 'confirmed', 'dismissed', 'cleared'))
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_sighting_id_sightings_id_fk" FOREIGN KEY ("sighting_id") REFERENCES "public"."sightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_cat_reporter_claim_day_idx" ON "reports" USING btree ("cat_id","reporter_id","claim","reported_on");--> statement-breakpoint
CREATE INDEX "reports_cat_idx" ON "reports" USING btree ("cat_id");--> statement-breakpoint
CREATE INDEX "reports_sighting_idx" ON "reports" USING btree ("sighting_id");