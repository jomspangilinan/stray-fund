CREATE TABLE "milestone_seen" (
	"user_id" uuid NOT NULL,
	"cat_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_seen_check" CHECK ("milestone_seen"."milestone" in ('neutered', 'adopted'))
);
--> statement-breakpoint
ALTER TABLE "milestone_seen" ADD CONSTRAINT "milestone_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_seen" ADD CONSTRAINT "milestone_seen_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_seen_key_idx" ON "milestone_seen" USING btree ("user_id","cat_id","milestone");