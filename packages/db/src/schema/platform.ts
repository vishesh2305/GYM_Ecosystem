import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { id } from "../columns";
import { users } from "./identity";

const tz = { withTimezone: true } as const;

/** Transactional outbox: written in the same transaction as the change; relayed to the queue by the worker. */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: id(),
    tenantId: uuid("tenant_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", tz).notNull().defaultNow(),
    publishedAt: timestamp("published_at", tz),
  },
  (t) => [
    index("outbox_events_unpublished_idx")
      .on(t.id)
      .where(sql`${t.publishedAt} is null`),
    index("outbox_events_published_at_idx").on(t.publishedAt),
  ],
);

/** One row per (event, handler) that completed, so redelivered events are not handled twice. */
export const handledEvents = pgTable(
  "handled_events",
  {
    eventId: uuid("event_id").notNull(),
    handler: text("handler").notNull(),
    handledAt: timestamp("handled_at", tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.handler] }),
    index("handled_events_handled_at_idx").on(t.handledAt),
  ],
);

/** Stored responses for Idempotency-Key requests (kept 24 h). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code"),
    responseBody: jsonb("response_body"),
    lockedAt: timestamp("locked_at", tz).notNull().defaultNow(),
    completedAt: timestamp("completed_at", tz),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.key] }),
    index("idempotency_keys_created_at_idx").on(t.createdAt),
  ],
);

/** Append-only record of who did what. Update/delete/truncate are blocked by trigger. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    tenantId: uuid("tenant_id"),
    actorType: text("actor_type", { enum: ["member", "staff", "admin", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    data: jsonb("data"),
    requestId: text("request_id"),
    ip: text("ip"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    key: text("key").primaryKey(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(false),
    rolloutPercent: smallint("rollout_percent").notNull().default(0),
    tenantIds: uuid("tenant_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    userIds: uuid("user_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    updatedAt: timestamp("updated_at", tz)
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("feature_flags_rollout_range", sql`${t.rolloutPercent} between 0 and 100`)],
);

/** People who run the platform itself (support, onboarding). Added by hand in the database, never by the API. */
export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  note: text("note"),
  grantedAt: timestamp("granted_at", tz).notNull().defaultNow(),
});
