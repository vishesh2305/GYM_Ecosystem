CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"slug" text,
	"name" text NOT NULL,
	"primary_muscle" text NOT NULL,
	"secondary_muscles" text[] DEFAULT '{}' NOT NULL,
	"equipment" text NOT NULL,
	"tracking" text NOT NULL,
	"media_key" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_slug_key" ON "exercises" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "exercises_user_idx" ON "exercises" USING btree ("user_id");