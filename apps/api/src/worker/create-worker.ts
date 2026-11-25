import { createDb } from "@gym/db";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import type { ApiEnv } from "../env";
import type { EventEnvelope, EventHandler } from "../platform/events";
import { runAutoCheckOut } from "../access/occupancy";
import { runAutopayRenewals } from "../billing/autopay-renewals";
import { createGateway } from "../billing/gateway";
import { runPaymentReminders } from "../billing/reminders";
import { runAttendance } from "../scheduling/attendance";
import { runSessionGeneration } from "../scheduling/timetable";
import { runMembershipLifecycle } from "../membership/lifecycle";
import { runMaintenance } from "../platform/maintenance";
import { createEmailSender, createSmsSender } from "../auth/senders";
import { createChannels, type ChannelAdapter } from "../notifications/channels";
import { runNotificationDelivery } from "../notifications/delivery";
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
  /** Message channels instead of the configured providers (tests pass fakes). */
  channels?: readonly ChannelAdapter[];
}

export type WorkerHandle = Awaited<ReturnType<typeof createWorker>>;

/** Background process: outbox relay, event handlers, member messages, hourly maintenance, membership upkeep, AutoPay renewals, auto check-out, class sessions and attendance. */
export async function createWorker(
  env: ApiEnv,
  { extraHandlers = [], autostart = true, channels }: WorkerOptions = {},
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

  const gateway = createGateway(env);
  const messageChannels =
    channels ?? createChannels(env, createSmsSender(env), createEmailSender(env));
  const deliveryOptions = {
    perGym: env.NOTIFY_PER_GYM_PER_RUN,
    maxAttempts: env.NOTIFY_MAX_ATTEMPTS,
    retryMs: env.NOTIFY_RETRY_MINUTES * 60_000,
  };
  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection, prefix: env.QUEUE_PREFIX });
  await maintenanceQueue.upsertJobScheduler(
    "maintenance-hourly",
    { every: HOUR },
    { name: "maintenance" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "notifications",
    { every: env.NOTIFY_POLL_MS },
    { name: "notifications" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "payment-reminders-hourly",
    { every: HOUR },
    { name: "payment-reminders" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "class-attendance-hourly",
    { every: HOUR },
    { name: "class-attendance" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "class-sessions-hourly",
    { every: HOUR },
    { name: "class-sessions" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "auto-check-out-hourly",
    { every: HOUR },
    { name: "auto-check-out" },
  );
  await maintenanceQueue.upsertJobScheduler(
    "autopay-renewals-hourly",
    { every: HOUR },
    { name: "autopay-renewals" },
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
        job.name === "notifications"
          ? await runNotificationDelivery(db.db, messageChannels, deliveryOptions)
          : job.name === "membership-lifecycle"
            ? await runMembershipLifecycle(db.db)
            : job.name === "class-attendance"
              ? await runAttendance(db.db)
              : job.name === "class-sessions"
                ? await runSessionGeneration(db.db)
                : job.name === "auto-check-out"
                  ? await runAutoCheckOut(db.db, env.CHECKIN_AUTO_OUT_HOURS)
                  : job.name === "autopay-renewals"
                    ? await runAutopayRenewals(db.db, gateway)
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
