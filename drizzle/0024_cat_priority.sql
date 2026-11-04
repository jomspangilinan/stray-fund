CREATE TABLE "cat_priority" (
	"cat_id" uuid PRIMARY KEY NOT NULL,
	"position" integer NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cat_priority" ADD CONSTRAINT "cat_priority_cat_id_cats_id_fk" FOREIGN KEY ("cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;