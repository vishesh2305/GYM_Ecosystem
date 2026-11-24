import { scopeToTenant, type Database } from "@gym/db";
import { handledEvents } from "@gym/db/schema";
import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { EventEnvelope, EventHandler } from "../platform/events";

export const EVENTS_QUEUE = "events";

/**
 * Runs every handler registered for an event. Each handler runs in its own transaction with a
 * (event, handler) marker, so a redelivered or retried event never repeats a handler that succeeded.
 * A throwing handler fails the job; BullMQ retries with backoff and keeps it in the failed set at the end.
 */
export class EventDispatcher {
  readonly worker: Worker<EventEnvelope>;

  constructor(
    private readonly db: Database,
    connection: Redis,
    private readonly handlers: readonly EventHandler[],
    private readonly logger: Logger,
    prefix = "bull",
  ) {
    this.worker = new Worker<EventEnvelope>(EVENTS_QUEUE, (job) => this.process(job), {
      connection,
      prefix,
      autorun: false,
      concurrency: 10,
    });
    this.worker.on("failed", (job, error) => {
      this.logger.warn(
        { err: error, eventId: job?.id, attempt: job?.attemptsMade },
        "event handler failed",
      );
    });
  }

  private async process(job: Job<EventEnvelope>): Promise<void> {
    const event = job.data;
    for (const handler of this.handlers.filter((h) => h.event.type === event.type)) {
      await this.db.transaction(async (tx) => {
        const marked = await tx
          .insert(handledEvents)
          .values({ eventId: event.id, handler: handler.name })
          .onConflictDoNothing()
          .returning({ eventId: handledEvents.eventId });
        if (!marked.length) return;
        if (event.tenantId) await scopeToTenant(tx, event.tenantId);
        await handler.handle(event.payload, { tx, event });
      });
    }
    this.logger.info({ eventId: event.id, type: event.type }, "event handled");
  }

  start(): void {
    if (this.worker.isPaused()) this.worker.resume();
    else if (!this.worker.isRunning()) void this.worker.run();
  }

  async pause(): Promise<void> {
    await this.worker.pause();
  }
}
