-- Who is acting, for person-scoped reads ("my organisations"). NULL when unset, which matches nothing.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Branches and staff: the standard tenant policy.
SELECT app.enable_tenant_rls('branches');
--> statement-breakpoint
SELECT app.enable_tenant_rls('staff_members');
--> statement-breakpoint
-- A person may also read their own staff memberships in any organisation.
CREATE POLICY own_memberships ON staff_members FOR SELECT
  USING (user_id = app.current_user_id());
--> statement-breakpoint

-- Organisations: the row's own id is the tenant id.
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisations
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());
--> statement-breakpoint
-- ...and a person may read the organisations they actively work at.
CREATE POLICY member_organisations ON organisations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM staff_members s
    WHERE s.tenant_id = organisations.id AND s.user_id = app.current_user_id() AND s.status = 'active'
  ));
