CREATE TABLE "member_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_name" text NOT NULL,
	"content" text,
	"default_branch_id" uuid NOT NULL,
	"total_rows" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "member_imports" ADD CONSTRAINT "member_imports_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_imports_tenant_idx" ON "member_imports" USING btree ("tenant_id");