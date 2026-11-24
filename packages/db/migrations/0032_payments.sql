CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"refunded_paise" integer DEFAULT 0 NOT NULL,
	"gateway" text,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"reference" text,
	"received_by" uuid,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_gateway_payment_unique" UNIQUE("gateway_payment_id"),
	CONSTRAINT "payments_gateway_order_unique" UNIQUE("gateway_order_id"),
	CONSTRAINT "payments_amounts" CHECK ("payments"."amount_paise" > 0 and "payments"."refunded_paise" between 0 and "payments"."amount_paise")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("tenant_id","invoice_id");