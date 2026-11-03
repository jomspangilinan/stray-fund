CREATE TABLE "name_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cat_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "name_suggestions_status_check" CHECK ("name_suggestions"."status" in ('pending', 'approved', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "cats" ADD COLUMN "name_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "name_suggestions" ADD CONSTRAINT "name_suggestions_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_suggestions" ADD CONSTRAINT "name_suggestions_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_suggestions" ADD CONSTRAINT "name_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "name_suggestions_pending_idx" ON "name_suggestions" USING btree ("cat_id","requester_id") WHERE "name_suggestions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "name_suggestions_pending_cat_idx" ON "name_suggestions" USING btree ("cat_id") WHERE "name_suggestions"."status" = 'pending';