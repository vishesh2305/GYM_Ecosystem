-- Foundation: app schema, the RLS-bound runtime role, tenant isolation and partition helpers.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- Runtime role. Never superuser, never BYPASSRLS. Requests switch to it with SET LOCAL ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT app_user TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
--> statement-breakpoint

-- Tenant of the current transaction; NULL when unset, which matches no rows.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Call once per tenant table in its module's migration: SELECT app.enable_tenant_rls('table_name');
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
    tbl
  );
END
$$;
--> statement-breakpoint

-- Monthly range partitions named <table>_yYYYYmMM, bounds at UTC month starts. Idempotent.
CREATE OR REPLACE FUNCTION app.create_monthly_partitions(parent regclass, start_month date, months int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  nsp text;
  rel text;
  m date;
BEGIN
  SELECT n.nspname, c.relname INTO nsp, rel
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = parent;

  FOR i IN 0 .. months - 1 LOOP
    m := (date_trunc('month', start_month) + make_interval(months => i))::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      nsp,
      rel || to_char(m, '"_y"YYYY"m"MM'),
      parent,
      (m::timestamp AT TIME ZONE 'UTC'),
      ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC')
    );
  END LOOP;
END
$$;
