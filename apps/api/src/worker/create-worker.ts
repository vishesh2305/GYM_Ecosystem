import { createDb } from "@gym/db";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import type { ApiEnv } from "../env";
import type { EventEnvelope, EventHandler } from "../platform/events";
import { runMaintenance } from "../platform/maintenance";
import { EVENTS_QUEUE, EventDispatcher } from "./event-dispatcher";
import { OutboxRelay } from "./outbox-relay";

const MAINTENANCE_QUEUE = "maintenance";
const HOUR = 3_600_000;

export interface WorkerOptions {
  handlers: readonly EventHandler[];
  /** Start relaying and processing immediately (tests drive these by hand). */
  autostart?: boolean;
}

export type WorkerHandle = Awaited<ReturnType<typeof createWorker>>;

/** Background process: outbox relay, event handlers and hourly maintenance. */
export async function createWorker(env: ApiEnv, { handlers, autostart = true }: WorkerOptions) {
  const logger = pino({ level: env.LOG_LEVEL, base: { process: "worker" } });
  const db = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const queue = new Queue<EventEnvelope>(EVENTS_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: env.EVENT_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: env.EVENT_BACKOFF_MS },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: false, // the failed set is the dead-letter queue
    },
  });
  const relay = new OutboxRelay(db.db, queue, logger, env.OUTBOX_BATCH, env.OUTBOX_POLL_MS);
  const dispatcher = new EventDispatcher(db.db, connection, handlers, logger);

  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
  await maintenanceQueue.upsertJobScheduler(
    "maintenance-hourly",
    { every: HOUR },
    { name: "maintenance" },
  );
  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async () => logger.info(await runMaintenance(db.db), "maintenance done"),
    { connection, autorun: false },
  );

  if (autostart) {
    relay.start();
    dispatcher.start();
    void maintenance.run();
  }

  let queueEvents: QueueEvents | undefined;
  return {
    relay,
    dispatcher,
    queue,
    maintenanceQueue,
    /** Created on first use; only needed to await job completion (tests, tooling). */
    get queueEvents(): QueueEvents {
      return (queueEvents ??= new QueueEvents(EVENTS_QUEUE, {
        connection: connection.duplicate(),
      }));
    },
    async close(): Promise<void> {
      relay.stop();
      await Promise.all([dispatcher.worker.close(), maintenance.close()]);
      await Promise.all([queue.close(), maintenanceQueue.close(), queueEvents?.close()]);
      connection.disconnect();
      await db.pool.end();
    },
  };
}
