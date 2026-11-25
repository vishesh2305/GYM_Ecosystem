CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"note" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "kyc_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "kyc_note" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "kyc_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;