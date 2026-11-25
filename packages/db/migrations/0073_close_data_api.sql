-- Supabase serves tables over its Data API (PostgREST) to the roles anon and authenticated, and by default grants
-- them every privilege on every new table in public. This platform never uses the Data API: all access goes
-- through the API service, with RLS as the second guard. So those roles get nothing, now or on future tables.
-- Where the roles do not exist (local development, tests) this does nothing.
CREATE OR REPLACE FUNCTION app.close_data_api() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public, app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, app FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.close_data_api() FROM PUBLIC;
--> statement-breakpoint
SELECT app.close_data_api();
