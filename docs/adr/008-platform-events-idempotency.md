# 008. Platform: outbox events, idempotency, audit, feature flags, worker

- Status: accepted
- Date: 2026-11-25

## Decision

**Events (transactional outbox).** Code calls `appendEvent(tx, event, payload, tenantId)` inside the same
transaction as the change. The worker's `OutboxRelay` reads unpublished rows with `FOR UPDATE SKIP LOCKED`,
adds them to the BullMQ `events` queue with `jobId = event id`, then marks them published. A crash between
enqueue and commit re-enqueues the same ids, which BullMQ ignores: each event is enqueued once.

**Handlers.** `defineHandler({ name, event, handle })`. The dispatcher runs each matching handler in its own
transaction, first inserting a `(event_id, handler)` marker into `handled_events`; a redelivered event skips
handlers that already succeeded. The transaction is scoped to the event's tenant (RLS). A throwing handler fails
the job: BullMQ retries with exponential backoff (`EVENT_MAX_ATTEMPTS`, `EVENT_BACKOFF_MS`) and keeps the job in
the failed set (dead-letter queue). External side effects (SMS, payments) must still use the provider's own
idempotency keys, because a crash after the call and before commit repeats the call.

**Idempotency-Key.** Global interceptor for POST/PUT/PATCH/DELETE. `@RequireIdempotencyKey()` makes the header
mandatory (money and access writes). First request stores the response; same key + same request replays it
(`idempotent-replayed: true`); same key + different request = 422; concurrent duplicate = 409; a failed request
releases the key; a lock older than 60 s is taken over. Keys live 24 h. Scope is the client IP until A7, then the
authenticated principal.

**Audit log.** `recordAudit(tx, entry)`. `app_user` may only insert; a trigger rejects UPDATE/DELETE/TRUNCATE for
every role, owner included. Audit rows must not contain personal data beyond actor ids.

**Feature flags.** Table `feature_flags`, cached in Redis for 30 s (`FeatureFlags.isEnabled`, `invalidate()`).
Evaluation is the pure `isFlagOn` in `@gym/domain`: allow-listed user/tenant → on; else a percentage rollout by
stable FNV-1a bucket of (flag, user or tenant); else the global switch. Unknown flags are off.

**Least privilege.** `app_user`: insert-only on `outbox_events` and `audit_log`, read-only on `feature_flags`,
no access to `idempotency_keys` and `handled_events`.

**Worker process.** Not a separate app: `apps/api/src/worker.ts` is a second entry point of the same codebase
(`pnpm --filter @gym/api start:worker`), so handlers can reuse every module. Hourly maintenance (BullMQ job
scheduler) deletes expired idempotency keys, old handled markers and published outbox rows; unpublished rows are
never deleted.

**One drizzle instance.** Apps import query helpers from `@gym/db/orm`; lint forbids importing `drizzle-orm`
elsewhere (two resolved copies break types).

## Consequences

Every module gets reliable async side effects, safe retries for money writes and an audit trail from day one.
