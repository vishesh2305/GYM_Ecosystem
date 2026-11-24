CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"account" text NOT NULL,
	"member_id" uuid,
	"debit_paise" integer DEFAULT 0 NOT NULL,
	"credit_paise" integer DEFAULT 0 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_one_sided" CHECK (("ledger_entries"."debit_paise" > 0 and "ledger_entries"."credit_paise" = 0) or ("ledger_entries"."credit_paise" > 0 and "ledger_entries"."debit_paise" = 0))
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_member_idx" ON "ledger_entries" USING btree ("tenant_id","member_id","account");