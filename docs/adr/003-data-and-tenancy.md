# 003. PostgreSQL, Drizzle, shared-schema multi-tenancy with RLS

- Status: accepted
- Date: 2026-11-24

## Context

Money, bookings and reporting need ACID transactions and joins. Thousands of gyms share one platform.

## Decision

- PostgreSQL (Supabase-managed in production, plain Postgres 17 locally). Drizzle ORM + drizzle-kit migrations.
- Shared schema: every tenant table has `tenant_id`; every index on it starts with `tenant_id`.
- Isolation enforced twice: application guard (tenant from JWT only) and Postgres Row-Level Security.
- High-volume tables partitioned by month. Path to scale: replicas → partitions → Citus sharded by `tenant_id`.

- Migrations are forward-only (drizzle-kit has no down migrations). A bad migration is fixed by a new migration; production rollbacks use point-in-time recovery.
- Runtime queries run as role `app_user` (NOSUPERUSER, NOBYPASSRLS) via `withTenant()`, which sets `app.tenant_id` with `set_config(..., true)` so it lasts one transaction only.
- Each module migration calls `SELECT app.enable_tenant_rls('<table>')` for its tenant tables.

## Consequences

Cross-tenant tests run on every PR. Tenant ID can never come from a request body.
