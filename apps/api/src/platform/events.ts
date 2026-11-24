import type { Tx } from "@gym/db";
import { outboxEvents } from "@gym/db/schema";
import { v7 } from "uuid";
import type { z } from "zod";

export interface EventDef<S extends z.ZodType = z.ZodType> {
  type: string;
  schema: S;
}

/** What travels through the queue for each outbox row. */
export interface EventEnvelope {
  id: string;
  type: string;
  tenantId: string | null;
  payload: unknown;
  occurredAt: string;
}

export interface EventContext {
  /** Transaction of the handler; scoped to the event's tenant when it has one. */
  tx: Tx;
  event: EventEnvelope;
}

export interface EventHandler {
  /** Stable name: part of the handled-once marker, so never rename a live handler. */
  name: string;
  event: EventDef;
  handle(payload: unknown, ctx: EventContext): Promise<void>;
}

export const defineEvent = <S extends z.ZodType>(type: string, schema: S): EventDef<S> => ({
  type,
  schema,
});

/** A typed handler; the payload is re-validated against the event schema before it runs. */
export function defineHandler<S extends z.ZodType>(handler: {
  name: string;
  event: EventDef<S>;
  handle(payload: z.output<S>, ctx: EventContext): Promise<void>;
}): EventHandler {
  return {
    name: handler.name,
    event: handler.event,
    handle: (payload, ctx) => handler.handle(handler.event.schema.parse(payload), ctx),
  };
}

/** Append an event in the caller's transaction, so it commits (or rolls back) with the change itself. */
export async function appendEvent<S extends z.ZodType>(
  tx: Tx,
  event: EventDef<S>,
  payload: z.input<S>,
  tenantId: string | null,
): Promise<string> {
  const id = v7();
  await tx
    .insert(outboxEvents)
    .values({ id, type: event.type, tenantId, payload: event.schema.parse(payload) });
  return id;
}

/** The tenant of a tenant-scoped event; a missing tenant is a programming error, never a silent fallback. */
export function requireTenant(event: EventEnvelope): string {
  if (!event.tenantId) throw new Error(`event ${event.type} ${event.id} has no tenant`);
  return event.tenantId;
}
