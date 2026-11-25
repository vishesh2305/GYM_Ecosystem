-- Data export and erasure (DPDP Act 2023) must find one person's rows in every gym, which RLS rightly prevents
-- for request handling. They run as app_privacy, used only by the worker's privacy job through withPrivacy():
-- it may cross tenants, may read the tables, and may change only what erasure needs (granted in its own
-- migration). Request handlers never use it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_privacy') THEN
    CREATE ROLE app_privacy NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT app_privacy TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO app_privacy;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_privacy;
--> statement-breakpoint
GRANT UPDATE (status, result, error, completed_at, expires_at) ON privacy_requests TO app_privacy;
