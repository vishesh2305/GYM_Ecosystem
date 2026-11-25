-- Public gym pages are looked up by slug before any gym is known, which RLS would otherwise hide. This function
-- returns only the id of a published, not deleted gym; everything shown on the page is then read in that gym's
-- own RLS scope. It runs as app_member_directory (see 0038), granted just these columns.
GRANT SELECT (slug, published) ON organisations TO app_member_directory;
--> statement-breakpoint
CREATE FUNCTION app.published_gym(gym_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM organisations WHERE slug = gym_slug AND published AND deleted_at IS NULL
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO app_member_directory;
--> statement-breakpoint
ALTER FUNCTION app.published_gym(text) OWNER TO app_member_directory;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM app_member_directory;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.published_gym(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.published_gym(text) TO app_user;
