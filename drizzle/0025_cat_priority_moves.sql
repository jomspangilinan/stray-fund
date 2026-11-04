-- Old rows were stored positions, not moves, and would read as "put last". The order is rebuilt from rank.ts.
DELETE FROM "cat_priority";--> statement-breakpoint
ALTER TABLE "cat_priority" ADD COLUMN "before_cat_id" uuid;--> statement-breakpoint
ALTER TABLE "cat_priority" ADD COLUMN "report_id" uuid;--> statement-breakpoint
ALTER TABLE "cat_priority" ADD CONSTRAINT "cat_priority_before_cat_id_cats_id_fk" FOREIGN KEY ("before_cat_id") REFERENCES "public"."cats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_priority" ADD CONSTRAINT "cat_priority_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cat_priority" DROP COLUMN "position";