# 007. API contracts, NestJS 12 and ESM

- Status: accepted
- Date: 2026-11-24

## Context

The plan called for zod-generated OpenAPI and a generated client (orval). ts-rest (zod 3, Nest ≤ 11) and nestjs-zod (Nest ≤ 11) do not support NestJS 12 with zod 4.

## Decision

- `@gym/contracts` holds every route as data (`defineRoute`: method, path, params, query, body, response, status).
  The same object drives server validation (`ZodPipe`), the OpenAPI 3.1 document (`buildOpenApi`, using zod 4's `z.toJSONSchema`) and the typed client (`createClient`). No code generation step.
- The client validates every response against the contract.
- `apps/api/openapi.json` is committed. CI fails if it drifts from the contracts, and fails PRs with breaking `/v1` changes (oasdiff).
- An e2e test asserts every contract route is served and every served `/v1` route is in the contract.
- NestJS 12 is ESM-only; the whole API is ESM. No `emitDecoratorMetadata`: every constructor dependency uses `@Inject(token)`, so any transpiler (tsx, Vitest, tsdown) works and imports can stay type-only.
- Errors: RFC 9457 problem details from one `ProblemFilter`; Nest also routes Fastify-level errors (body limit, bad JSON, rate limit) through it. 5xx responses never include internal messages.
- Rate limiting is Redis-backed and fails open when Redis is down (availability first; `/v1/ready` reports it). Keyed by IP until auth exists; per-user and per-tenant keys are added in A7/A8.
- Production build: tsdown bundles the API and workspace packages to `dist/main.mjs`; npm dependencies stay external.
- Tracing: OpenTelemetry loads via `--import dist/instrumentation.mjs` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Node 26 prints a deprecation warning for `module.register()` used by the OTel ESM hook; switch when OTel ships `registerHooks` support.

## Consequences

One source of truth for the API shape across server, docs, mobile and web. Contract changes are visible in review through `openapi.json` diffs.
