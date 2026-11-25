CREATE TABLE "notification_preferences" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"disabled_channels" text[] DEFAULT '{}' NOT NULL,
	"muted_categories" text[] DEFAULT '{}' NOT NULL,
	"quiet_start" text DEFAULT '21:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;