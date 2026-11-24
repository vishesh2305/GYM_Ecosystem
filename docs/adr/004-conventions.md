# 004. Data and API conventions

- Status: accepted
- Date: 2026-11-24

## Decision

- IDs: UUIDv7.
- Time: `timestamptz`, stored and transported in UTC (ISO 8601); display in tenant time zone.
- Money: integer minor units + ISO 4217 currency code. Never floats. Splits use `allocate()` from `@gym/domain`; tax uses `applyBasisPoints()` (half-up).
- Errors: RFC 9457 problem details (`application/problem+json`).
- API: REST under `/v1`, OpenAPI generated from zod schemas; additive changes only within a version.
- Writes that move money or access require an `Idempotency-Key` header.
- Environment validated with zod at boot (`@gym/config`); error messages never include values.
