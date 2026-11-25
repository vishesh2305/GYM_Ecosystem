-- Platform admins: a person may only see whether they themselves are one; nobody can add one through the API.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_row ON platform_admins FOR SELECT USING (user_id = app.current_user_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_admins FROM app_user;
--> statement-breakpoint

-- The admin console looks across gyms, which RLS prevents for request handling. It runs as app_admin through
-- withAdmin(), only behind the platform-admin guard: it may read what the console shows and change only a
-- gym's KYC review and the feature flags, recording each change in the audit log.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT app_admin TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO app_admin;
--> statement-breakpoint
GRANT SELECT ON organisations, branches, members, staff_members, feature_flags TO app_admin;
--> statement-breakpoint
GRANT SELECT (id, name, phone, email) ON users TO app_admin;
--> statement-breakpoint
GRANT UPDATE (kyc_status, kyc_note, kyc_reviewed_at, updated_at) ON organisations TO app_admin;
--> statement-breakpoint
GRANT INSERT, UPDATE ON feature_flags TO app_admin;
--> statement-breakpoint
GRANT INSERT ON audit_log TO app_admin;
--> statement-breakpoint
-- Erasure removes a person's admin row with the rest of their account.
GRANT DELETE ON platform_admins TO app_privacy;
--> statement-breakpoint
GRANT SELECT ON platform_admins TO app_privacy;
