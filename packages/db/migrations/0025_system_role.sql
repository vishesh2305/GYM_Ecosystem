-- Background-job role: may bypass RLS, but is granted almost nothing (least privilege).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT app_system TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO app_system;
--> statement-breakpoint
GRANT SELECT (id, timezone, deleted_at) ON organisations TO app_system;
