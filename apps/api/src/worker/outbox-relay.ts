import type { Database } from "@gym/db";
import { outboxEvents } from "@gym/db/schema";
import type { Queue } from "bullmq";
import { inArray, isNull } from "@gym/db/orm";
import type { Logger } from "pino";
import type { EventEnvelope } from "../platform/events";

/**
 * Moves committed outbox rows to the queue. The job id is the event id, so a crash between enqueue and
 * marking the rows published re-enqueues nothing new: BullMQ ignores a job id it already holds.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly queue: Queue<EventEnvelope>,
    private readonly logger: Logger,
    private readonly batch: number,
    private readonly pollMs: number,
  ) {}

  /** Relay one batch. Returns how many events were relayed. */
  async drainOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(outboxEvents.id)
        .limit(this.batch)
        .for("update", { skipLocked: true });
      if (!rows.length) return 0;

      await this.queue.addBulk(
        rows.map((row) => ({
          name: row.type,
          data: {
            id: row.id,
            type: row.type,
            tenantId: row.tenantId,
            payload: row.payload,
            occurredAt: row.occurredAt.toISOString(),
          },
          opts: { jobId: row.id },
        })),
      );
      await tx
        .update(outboxEvents)
        .set({ publishedAt: new Date() })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      try {
        while ((await this.drainOnce()) === this.batch && this.running);
      } catch (error) {
        this.logger.error({ err: error }, "outbox relay failed; retrying");
      } finally {
        if (this.running) this.timer = setTimeout(() => void tick(), this.pollMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }
}
