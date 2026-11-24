# GYM_Ecosystem

Gym ecosystem: Gym OS (owners/staff), member app, coach workspace, brand marketplace.
Plans: `~/gym-platform-plan.md` (product) and `~/gym-platform-build-plan.md` (build steps).

## Requirements

- Node 24+ (`.nvmrc`), pnpm 12, Docker Desktop

## Commands

| Command                               | What it does                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm install`                        | Install dependencies                                                                                       |
| `cp .env.example .env`                | Local configuration (never commit `.env`)                                                                  |
| `pnpm --filter @gym/api keys >> .env` | Create the token signing key; also set `AUTH_SECRET` and `AUTH_ENCRYPTION_KEY` (`openssl rand -base64 32`) |
| `pnpm dev:up` / `pnpm dev:down`       | Start / stop Postgres (54320), Valkey (63790), Mailpit (UI on 8025)                                        |
| `pnpm db:migrate`                     | Apply database migrations to the database in `.env`                                                        |
| `pnpm db:generate`                    | Create a migration from schema changes in `packages/db/src/schema`                                         |
| `pnpm db:seed`                        | Load the demo gym "Demo Fitness" (2 branches; staff sign in with +91 99000 00001 to 00004)                 |
| `pnpm --filter @gym/api dev`          | Run the API with reload on http://localhost:3000 (docs at `/v1/docs.json`)                                 |
| `pnpm --filter @gym/api dev:worker`   | Run the background worker (outbox relay, event handlers, maintenance)                                      |
| `pnpm build`                          | Production build (`apps/api/dist`)                                                                         |
| `pnpm --filter @gym/api openapi`      | Regenerate `apps/api/openapi.json` after contract changes                                                  |
| `pnpm check`                          | Lint + type-check + tests (with coverage gates) for every package                                          |
| `pnpm format`                         | Prettier                                                                                                   |

Local ports avoid 5432/6379 so this project does not clash with other local databases.

## Layout

```
apps/
  api/         NestJS 12 + Fastify HTTP API (/v1) and the worker entry point (src/worker.ts)
packages/
  domain/      pure business rules (money, feature-flag evaluation, …) — no I/O
  config/      zod-validated environment loading
  contracts/   route contracts (zod): server validation, OpenAPI, typed client
  db/          Drizzle schema, migrations, tenant scope (RLS), column helpers
docs/adr/      architecture decision records
docs/backlog/  user stories with acceptance criteria
```

## Rules

Tests first for business rules. CI must be green to merge.
One commit per feature, titled in plain English (10-72 characters, no full stop), e.g. "Add phone number sign-in with one-time codes". A short body explains what changed for users; technical details go below it.
See `docs/adr/` for decisions.
