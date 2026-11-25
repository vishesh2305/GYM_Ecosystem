CREATE TABLE "autopay_mandates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"status" text NOT NULL,
	"max_amount_paise" integer NOT NULL,
	"gateway" text NOT NULL,
	"gateway_customer_id" text NOT NULL,
	"gateway_order_id" text NOT NULL,
	"gateway_token_id" text,
	"created_by" uuid,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopay_mandates_max_positive" CHECK ("autopay_mandates"."max_amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "renewed_by_mandate_id" uuid;--> statement-breakpoint
ALTER TABLE "autopay_mandates" ADD CONSTRAINT "autopay_mandates_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_mandates" ADD CONSTRAINT "autopay_mandates_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autopay_mandates_one_live_per_member" ON "autopay_mandates" USING btree ("tenant_id","member_id") WHERE "autopay_mandates"."status" in ('pending', 'active');