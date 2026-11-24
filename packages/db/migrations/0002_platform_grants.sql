-- Least privilege for the runtime role on platform tables (default privileges granted full DML).

-- Outbox: tenants may append events, never read or change them.
REVOKE SELECT, UPDATE, DELETE ON outbox_events FROM app_user;
--> statement-breakpoint
-- Worker/interceptor-only tables.
REVOKE ALL ON idempotency_keys, handled_events FROM app_user;
--> statement-breakpoint
-- Audit: append only.
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;
--> statement-breakpoint
-- Flags: read only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON feature_flags FROM app_user;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
