import type { Database } from "@gym/db";
import { handledEvents, idempotencyKeys, outboxEvents } from "@gym/db/schema";
import { lt } from "@gym/db/orm";

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Hourly cleanup. Unpublished outbox rows are never deleted. */
export async function runMaintenance(db: Database) {
  const keys = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, ago(24 * HOUR)));
  const markers = await db
    .delete(handledEvents)
    .where(lt(handledEvents.handledAt, ago(7 * 24 * HOUR)));
  const events = await db
    .delete(outboxEvents)
    .where(lt(outboxEvents.publishedAt, ago(7 * 24 * HOUR)));
  return {
    idempotencyKeys: Number(keys.rowCount),
    handledEvents: Number(markers.rowCount),
    outboxEvents: Number(events.rowCount),
  };
}
