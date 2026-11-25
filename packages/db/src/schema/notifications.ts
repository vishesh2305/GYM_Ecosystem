import {
  CHANNELS,
  DEFAULT_QUIET_HOURS,
  LOCALES,
  MUTABLE_CATEGORIES,
  type MessageKey,
} from "@gym/domain";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "../columns";
import { users } from "./identity";
import { members } from "./membership";
import { organisations } from "./tenancy";

const tz = { withTimezone: true } as const;

export const NOTIFICATION_STATUSES = ["pending", "sent", "failed", "skipped"] as const;

/**
 * Every message to a member: queued here, then delivered by the worker over the first channel that works.
 * `dedupe_key` (unique per gym) makes each trigger send at most once, however often it fires.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    key: text("key").$type<MessageKey>().notNull(),
    /** Template variables, formatted only when sent (in the member's language at that time). */
    vars: jsonb("vars").$type<Record<string, string | number>>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: NOTIFICATION_STATUSES }).notNull().default("pending"),
    /** Not sent before this (quiet hours, retry back-off). */
    sendAfter: timestamp("send_after", tz).notNull().defaultNow(),
    /** Pointless after this (a class reminder once the class has started): skipped instead. */
    expiresAt: timestamp("expires_at", tz),
    attempts: smallint("attempts").notNull().default(0),
    channel: text("channel", { enum: CHANNELS }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", tz),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("notifications_dedupe_key").on(t.tenantId, t.dedupeKey),
    index("notifications_due_idx")
      .on(t.tenantId, t.sendAfter)
      .where(sql`${t.status} = 'pending'`),
    index("notifications_member_idx").on(t.tenantId, t.memberId, t.createdAt),
  ],
);

/** Phones that receive app push notifications (Expo push tokens), owned by the signed-in person. */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    platform: text("platform", { enum: ["ios", "android"] }).notNull(),
    /** Set when the push service says the app was uninstalled or the token expired. */
    disabledAt: timestamp("disabled_at", tz),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("push_devices_token_key").on(t.token),
    index("push_devices_user_idx").on(t.userId),
  ],
);

/** How a member wants to hear from their gym. No row means the defaults. */
export const notificationPreferences = pgTable("notification_preferences", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => members.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  locale: text("locale", { enum: LOCALES }).notNull().default("en"),
  disabledChannels: text("disabled_channels", { enum: CHANNELS })
    .array()
    .notNull()
    .default(sql`'{}'`),
  mutedCategories: text("muted_categories", { enum: MUTABLE_CATEGORIES })
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** "HH:MM" in the gym's time zone; equal values mean no quiet hours. */
  quietStart: text("quiet_start").notNull().default(DEFAULT_QUIET_HOURS.start),
  quietEnd: text("quiet_end").notNull().default(DEFAULT_QUIET_HOURS.end),
  ...timestamps,
});
