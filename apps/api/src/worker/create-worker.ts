import { createDb } from "@gym/db";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import type { ApiEnv } from "../env";
import type { EventEnvelope, EventHandler } from "../platform/events";
import { runPaymentReminders } from "../billing/reminders";
import { runMembershipLifecycle } from "../membership/lifecycle";
import { runMaintenance } from "../platform/maintenance";
import { EVENTS_QUEUE, EventDispatcher } from "./event-dispatcher";
import { handlers } from "./handlers";
import { OutboxRelay } from "./outbox-relay";

const MAINTENANCE_QUEUE = "maintenance";
const HOUR = 3_600_000;

export interface WorkerOptions {
  /** Added to every production handler (tests use this for test-only events). */
  extraHandlers?: readonly EventHandler[];
  /** Start relaying and processing immediately (tests drive these by hand). */
  autostart?: boolean;
}

export type WorkerHandle = Awaited<ReturnType<typeof createWorker>>;

/** Background process: outbox relay, event handlers, hourly maintenance and membership upkeep. */
export async function createWorker(
  env: ApiEnv,
  { extraHandlers = [], autostart = true }: WorkerOptions = {},
) {
  const logger = pino({ level: env.LOG_LEVEL, base: { process: "worker" } });
  const db = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const queue = new Queue<EventEnvelope>(EVENTS_QUEUE, {
    connection,
    prefix: env.QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: env.EVENT_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: env.EVENT_BACKOFF_MS },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: false, // the failed set is the dead-letter queue
    },
  });
  const relay = new OutboxRelay(db.db, queue, logger, env.OUTBOX_BATCH, env.OUTBOX_POLL_MS);
  const dispatcher = new EventDispatcher(
    db.db,
    connection,
    [...handlers, ...extraHandlers],
    logger,
    env.QUEUE_PREFIX,
  );

  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection, prefix: env.QUEUE_PREFIX });
  await maintenanceQueue.upsertJobScheduler(
    "maintenance-hourly",
    { every: HOUR },
    { name: "maintenance" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "payment-reminders-hourly",
    { every: HOUR },
    { name: "payment-reminders" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "membership-lifecycle-hourly",
    { every: HOUR },
    { name: "membership-lifecycle" },
  );
  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      const result =
        job.name === "membership-lifecycle"
          ? await runMembershipLifecycle(db.db)
          : job.name === "payment-reminders"
            ? await runPaymentReminders(db.db, env.DUNNING_GRACE_DAYS)
            : await runMaintenance(db.db);
      logger.info({ job: job.name, ...result }, "scheduled job done");
    },
    { connection, prefix: env.QUEUE_PREFIX, autorun: false },
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
        prefix: env.QUEUE_PREFIX,
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
