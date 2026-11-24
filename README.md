# GYM_Ecosystem

Gym ecosystem: Gym OS (owners/staff), member app, coach workspace, brand marketplace.
Plans: `~/gym-platform-plan.md` (product) and `~/gym-platform-build-plan.md` (build steps).

## Requirements

- Node 24+ (`.nvmrc`), pnpm 12, Docker Desktop

## Commands

| Command                         | What it does                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| `pnpm install`                  | Install dependencies                                                |
| `cp .env.example .env`          | Local configuration (never commit `.env`)                           |
| `pnpm dev:up` / `pnpm dev:down` | Start / stop Postgres (54320), Valkey (63790), Mailpit (UI on 8025) |
| `pnpm check`                    | Lint + type-check + tests (with coverage gates) for every package   |
| `pnpm format`                   | Prettier                                                            |

Local ports avoid 5432/6379 so this project does not clash with other local databases.

## Layout

```
apps/          deployables (api, worker — added in A5)
packages/
  domain/      pure business rules (money, proration, …) — no I/O
  config/      zod-validated environment loading
  db/          Drizzle schema, migrations, tenant scope (RLS), column helpers
docs/adr/      architecture decision records
docs/backlog/  user stories with acceptance criteria
```

## Rules

Tests first for business rules. CI must be green to merge. Conventional commits (enforced by commitlint).
See `docs/adr/` for decisions.
