# 002. Backend: NestJS on Fastify, modular monolith

- Status: accepted
- Date: 2026-11-24

## Context

Phase 1 needs fast delivery with clean boundaries, and a path to scale to many concurrent users.

## Decision

- `apps/api` (HTTP) and `apps/worker` (queues, schedules, outbox relay), both NestJS on the Fastify adapter.
- One Nest module per domain (identity, tenancy, membership, billing, access, scheduling, training, notifications, crm, platform). Clean architecture inside each: domain → application → infrastructure → interface.
- Modules communicate through public interfaces or domain events; never through each other's tables.
- Stateless processes; scale horizontally. Hot paths may move to Go services later (see product plan, scalability).

## Consequences

Single deployable early; any module can be extracted later without a rewrite.
