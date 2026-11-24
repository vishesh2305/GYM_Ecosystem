CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration_unit" text NOT NULL,
	"duration_count" smallint NOT NULL,
	"price_paise" integer NOT NULL,
	"gst_rate_bps" smallint DEFAULT 1800 NOT NULL,
	"joining_fee_paise" integer DEFAULT 0 NOT NULL,
	"is_trial" boolean DEFAULT false NOT NULL,
	"branch_ids" uuid[] DEFAULT '{}' NOT NULL,
	"max_freezes" smallint DEFAULT 0 NOT NULL,
	"max_freeze_days" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_price_non_negative" CHECK ("plans"."price_paise" >= 0 and "plans"."joining_fee_paise" >= 0),
	CONSTRAINT "plans_duration_positive" CHECK ("plans"."duration_count" > 0),
	CONSTRAINT "plans_gst_slab" CHECK ("plans"."gst_rate_bps" in (0, 500, 1200, 1800, 2800))
);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_tenant_idx" ON "plans" USING btree ("tenant_id");