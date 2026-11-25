-- Members sign in to the app with the phone number their gym has on file. app.my_gyms() links such members to
-- the signed-in user (verified phone only) and lists them. It runs as its own role, which may cross tenants but
-- owns nothing else and is granted only the columns this needs (the background-job role stays as narrow as
-- before). Callers (app_user) can execute the function and nothing more.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_member_directory') THEN
    CREATE ROLE app_member_directory NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT app_member_directory TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO app_member_directory;
--> statement-breakpoint
GRANT SELECT (id, phone, phone_verified_at) ON users TO app_member_directory;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, name, phone, user_id, deleted_at), UPDATE (user_id) ON members
  TO app_member_directory;
--> statement-breakpoint
GRANT SELECT (id, name, deleted_at) ON organisations TO app_member_directory;
--> statement-breakpoint
CREATE FUNCTION app.my_gyms()
RETURNS TABLE (tenant_id uuid, org_name text, member_id uuid, member_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := app.current_user_id();
BEGIN
  IF uid IS NULL THEN
    RETURN;
  END IF;
  UPDATE members m SET user_id = uid
    FROM users u
    WHERE u.id = uid AND u.phone_verified_at IS NOT NULL AND m.phone = u.phone
      AND m.user_id IS NULL AND m.deleted_at IS NULL;
  RETURN QUERY
    SELECT m.tenant_id, o.name, m.id, m.name
    FROM members m JOIN organisations o ON o.id = m.tenant_id
    WHERE m.user_id = uid AND m.deleted_at IS NULL AND o.deleted_at IS NULL
    ORDER BY o.name, m.id;
END
$$;
--> statement-breakpoint
-- Changing the owner needs CREATE on the schema; it is granted only for this statement.
GRANT CREATE ON SCHEMA app TO app_member_directory;
--> statement-breakpoint
ALTER FUNCTION app.my_gyms() OWNER TO app_member_directory;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM app_member_directory;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.my_gyms() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.my_gyms() TO app_user;
