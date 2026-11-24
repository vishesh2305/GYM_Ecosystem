# 010. Organisations, staff roles and tenant isolation

- Status: accepted (refines ADR 003)
- Date: 2026-11-25

## Decision

**Tenant = organisation** (a gym business). Its id is the `tenant_id` of every row it owns. Branches,
staff memberships and invites are tenant rows with RLS.

**Which tenant a request acts in.** Gym endpoints live under `/v1/orgs/{orgId}/...`. The id comes from the
path, but `TenantGuard` accepts it only if the signed-in person has an _active_ staff membership there; otherwise
it answers 404 (never 403), so other gyms' existence is not revealed. This replaces "tenant from token" in
ADR 003: people can work at several gyms, and removing or suspending someone takes effect on the next request.
All tenant queries then run in `withTenant(orgId)`, so RLS filters them a second time.

**Person scope.** `withUser(userId)` sets `app.user_id`; extra SELECT policies let a person read their own staff
memberships and the organisations they actively work at ("my gyms", membership checks). Identity tables stay
outside RLS and are only read with ids that came from RLS-filtered rows.

**Roles.** `owner`, `manager`, `front_desk`, `trainer`. `@Roles(...)` on a route returns 403 for other roles.
Owners change business details, staff roles and removals; owners and managers open branches and invite staff;
managers may invite only front desk and trainers. A gym always keeps at least one active owner.

**Branch scope.** A membership with `branchIds` is limited to those branches (`canUseBranch`, `isBranchScoped`):
other branches are 404, they cannot open branches or invite outside their branches, and they see only colleagues
who share a branch or work everywhere. Later modules (members, classes, check-in) use the same helpers.

**Two-step verification.** With `STAFF_MFA_REQUIRED` (default true), owners, managers and front desk need a session
with `mfa` in `amr` for any gym endpoint. Trainers are exempt; registering a gym is allowed before setting it up.

**Invites.** Token `<orgId>.<32 random bytes>`, SHA-256 stored, 7-day expiry, single use (atomic claim), only
acceptable by a user who has proven the phone or email it was sent to. Sent by SMS or email with an `APP_URL` link.

**Proof of isolation.** `test/cross-tenant.e2e.test.ts` derives its cases from the API contract: every route with
`{orgId}` is attacked with another gym's id and with another gym's nested ids; all must be 404 and the victim's
data must be unchanged. New routes are included automatically.

## Consequences

- Every gym-scoped feature must sit under `/v1/orgs/{orgId}`, use `@TenantScoped()` and `withTenant`.
- Known gap: test databases connect as a superuser. RLS is still enforced because queries switch to `app_user`,
  but code that forgets `withTenant` would only fail where the connection role is not a superuser. Staging (A17)
  must connect as a non-superuser role so such mistakes surface before production.
