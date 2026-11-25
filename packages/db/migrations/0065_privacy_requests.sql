CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "privacy_requests_user_idx" ON "privacy_requests" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_pending_idx" ON "privacy_requests" USING btree ("status","requested_at");