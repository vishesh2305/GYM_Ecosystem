-- Exactly the changes erasure makes (see packages/db/src/personal-data.ts and apps/api/src/privacy/erase.ts).
-- Deleting the user cascades to their account and training rows through foreign keys.
GRANT DELETE ON users, otp_challenges, staff_invites, notifications, notification_preferences, member_passes,
  lead_tasks TO app_privacy;
--> statement-breakpoint
GRANT UPDATE (name, phone, email, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, notes,
  user_id, deleted_at, updated_at) ON members TO app_privacy;
--> statement-breakpoint
GRANT UPDATE (name, phone, email, interest, stage, lost_reason, consent_at, updated_at) ON leads TO app_privacy;
--> statement-breakpoint
GRANT UPDATE (reason) ON membership_freezes TO app_privacy;
--> statement-breakpoint
GRANT UPDATE (status, cancelled_at) ON autopay_mandates TO app_privacy;
--> statement-breakpoint
GRANT INSERT ON audit_log TO app_privacy;
