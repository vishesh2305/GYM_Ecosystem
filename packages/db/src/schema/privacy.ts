import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../columns";

const tz = { withTimezone: true } as const;

/**
 * A person's request to download their data or to be erased (DPDP Act 2023), handled by the worker. No foreign
 * key to users: the record outlives an erased account as proof the request was honoured.
 */
export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    kind: text("kind", { enum: ["export", "erasure"] }).notNull(),
    status: text("status", { enum: ["pending", "done", "failed"] })
      .notNull()
      .default("pending"),
    /** The export itself; cleared when it expires. */
    result: jsonb("result"),
    error: text("error"),
    requestedAt: timestamp("requested_at", tz).notNull().defaultNow(),
    completedAt: timestamp("completed_at", tz),
    /** Exports can be downloaded until then. */
    expiresAt: timestamp("expires_at", tz),
  },
  (t) => [
    index("privacy_requests_user_idx").on(t.userId, t.requestedAt),
    index("privacy_requests_pending_idx").on(t.status, t.requestedAt),
  ],
);
