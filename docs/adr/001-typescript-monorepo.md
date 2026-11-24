# 001. One TypeScript monorepo

- Status: accepted
- Date: 2026-11-24

## Context

Mobile (iOS/Android), web portals and backend must share types, validation and business rules without copies.

## Decision

- One repo, pnpm workspaces + Turborepo. `apps/*` are thin; logic lives in `packages/*`.
- TypeScript strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Internal packages export TypeScript source (`exports: ./src/index.ts`); no build step for packages.
- Packages are created when the first step needs them, not up front.
- TypeScript pinned to 6.0.x: typescript-eslint 8.73 supports `<6.1`. Upgrade to 7.x when typescript-eslint supports it.

## Consequences

One CI, cached builds, one hiring profile. Package boundaries must be enforced by lint rules (added with the first app in A5).
