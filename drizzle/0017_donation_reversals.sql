CREATE TABLE "donation_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"paypal_ref" text NOT NULL,
	"gross_delta" integer NOT NULL,
	"fee_delta" integer NOT NULL,
	"net_delta" integer NOT NULL,
	"basis" text NOT NULL,
	"review_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donation_reversals_paypal_ref_unique" UNIQUE("paypal_ref"),
	CONSTRAINT "donation_reversals_kind_check" CHECK ("donation_reversals"."kind" in ('refund', 'reversal', 'denied')),
	CONSTRAINT "donation_reversals_basis_check" CHECK ("donation_reversals"."basis" in ('breakdown', 'remaining')),
	CONSTRAINT "donation_reversals_sign_check" CHECK ("donation_reversals"."gross_delta" <= 0 and "donation_reversals"."fee_delta" <= 0 and "donation_reversals"."net_delta" <= 0),
	CONSTRAINT "donation_reversals_breakdown_check" CHECK ("donation_reversals"."gross_delta" = "donation_reversals"."fee_delta" + "donation_reversals"."net_delta")
);
--> statement-breakpoint
ALTER TABLE "donation_reversals" ADD CONSTRAINT "donation_reversals_donation_id_donations_id_fk" FOREIGN KEY ("donation_id") REFERENCES "public"."donations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_reversals" ADD CONSTRAINT "donation_reversals_review_request_id_review_requests_id_fk" FOREIGN KEY ("review_request_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "donation_reversals_donation_idx" ON "donation_reversals" USING btree ("donation_id");