import type { Database, DbHandle } from "@gym/db";
import { sql } from "@gym/db/orm";
import { context, metrics } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import type { Queue } from "bullmq";

// Gauges for the dashboards. Request rate, errors and latency come from the HTTP instrumentation; these add
// what it cannot see. They are read only when metrics are exported (instrumentation.ts), otherwise no-ops.
const meter = () => metrics.getMeter("gym-api");

/** Database connections in use, idle and waiting, for one connection pool of this process. */
export function observePool(pool: DbHandle["pool"], name: string): void {
  meter()
    .createObservableGauge("db.client.connection.count", {
      description: "Database connections by state",
    })
    .addCallback((result) => {
      result.observe(pool.totalCount - pool.idleCount, { pool: name, state: "used" });
      result.observe(pool.idleCount, { pool: name, state: "idle" });
      result.observe(pool.waitingCount, { pool: name, state: "waiting" });
    });
}

/** Background jobs by queue and state; "failed" is the dead-letter queue. */
export function observeQueues(queues: readonly Queue[]): void {
  meter()
    .createObservableGauge("queue.jobs", { description: "Background jobs by queue and state" })
    .addCallback(async (result) => {
      for (const queue of queues) {
        const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
        for (const [state, n] of Object.entries(counts))
          result.observe(n, { queue: queue.name, state });
      }
    });
}

/** Events saved with their change but not yet handed to the queue, and how long the oldest has waited. */
export function observeOutbox(db: Database): void {
  const backlog = meter().createObservableGauge("outbox.backlog", {
    description: "Events not yet relayed to the queue",
  });
  const oldest = meter().createObservableGauge("outbox.oldest_age", {
    description: "Age of the oldest event not yet relayed",
    unit: "s",
  });
  meter().addBatchObservableCallback(
    async (result) => {
      const { rows } = await db.execute<{ n: number; age: number }>(
        sql`select count(*)::int as n,
              coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as age
            from outbox_events where published_at is null`,
      );
      result.observe(backlog, rows[0]?.n ?? 0);
      result.observe(oldest, rows[0]?.age ?? 0);
    },
    [backlog, oldest],
  );
}

/**
 * Per-endpoint request metrics: tells the HTTP instrumentation which route matched, as its template (e.g.
 * /v1/orgs/:orgId/members), never the raw URL. Unmatched requests stay unlabelled. Called on every request.
 */
export function labelRoute(route: string | undefined): void {
  const rpc = getRPCMetadata(context.active());
  if (rpc?.type === RPCType.HTTP && route) rpc.route = route;
}
