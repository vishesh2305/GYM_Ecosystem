SELECT app.enable_tenant_rls('notifications');
--> statement-breakpoint
SELECT app.enable_user_rls('push_devices');
--> statement-breakpoint

-- Push tokens belong to people, messages are sent by gyms. These functions bridge the two, narrowly: a gym can
-- read and disable only the tokens of its own members (people linked to one of its member records), and a
-- signed-in person can register a token, which moves it from whoever used the phone before. They run as
-- app_member_directory (see 0038), which is granted only the push_devices columns they need.
GRANT SELECT (id, user_id, token, platform, disabled_at, created_at),
  INSERT (id, user_id, token, platform),
  UPDATE (user_id, platform, disabled_at, updated_at)
  ON push_devices TO app_member_directory;
--> statement-breakpoint
CREATE FUNCTION app.member_push_tokens(member uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.token
  FROM push_devices d JOIN members m ON m.user_id = d.user_id
  WHERE m.id = member AND m.tenant_id = app.current_tenant_id() AND m.deleted_at IS NULL
    AND d.disabled_at IS NULL
  ORDER BY d.created_at
$$;
--> statement-breakpoint
CREATE FUNCTION app.disable_push_tokens(member uuid, tokens text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE push_devices d SET disabled_at = now(), updated_at = now()
  FROM members m
  WHERE m.id = member AND m.tenant_id = app.current_tenant_id() AND d.user_id = m.user_id
    AND d.token = ANY(tokens) AND d.disabled_at IS NULL
$$;
--> statement-breakpoint
CREATE FUNCTION app.register_push_device(tok text, plat text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := app.current_user_id();
  device uuid;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'no signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO push_devices (id, user_id, token, platform)
    VALUES (gen_random_uuid(), uid, tok, plat)
    ON CONFLICT (token) DO UPDATE
      SET user_id = uid, platform = plat, disabled_at = NULL, updated_at = now()
    RETURNING id INTO device;
  RETURN device;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO app_member_directory;
--> statement-breakpoint
ALTER FUNCTION app.member_push_tokens(uuid) OWNER TO app_member_directory;
--> statement-breakpoint
ALTER FUNCTION app.disable_push_tokens(uuid, text[]) OWNER TO app_member_directory;
--> statement-breakpoint
ALTER FUNCTION app.register_push_device(text, text) OWNER TO app_member_directory;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM app_member_directory;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.member_push_tokens(uuid), app.disable_push_tokens(uuid, text[]),
  app.register_push_device(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_push_tokens(uuid), app.disable_push_tokens(uuid, text[]),
  app.register_push_device(text, text) TO app_user;
