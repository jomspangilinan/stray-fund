ALTER TABLE "users" ADD COLUMN "clinic_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_cat_open_idx" ON "bookings" USING btree ("cat_id") WHERE "bookings"."status" = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_booking_live_idx" ON "receipts" USING btree ("booking_id") WHERE "receipts"."verification" in ('pending', 'verified');--> statement-breakpoint
CREATE UNIQUE INDEX "treatments_receipt_type_idx" ON "treatments" USING btree ("receipt_id","type") WHERE "treatments"."receipt_id" is not null;