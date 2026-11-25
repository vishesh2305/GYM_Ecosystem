import { boolean, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, softDelete, timestamps } from "../columns";
import { users } from "./identity";

/** A gym business (the tenant). Its id is the `tenant_id` of every row it owns. */
export const organisations = pgTable("organisations", {
  id: id(),
  name: text("name").notNull(),
  /** Indian GST number, if registered. */
  gstin: text("gstin"),
  countryCode: text("country_code").notNull().default("IN"),
  currency: text("currency").notNull().default("INR"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  /** Address of the public gym page (/gyms/<slug>), unique across gyms. */
  slug: text("slug").unique(),
  /** The public page and enquiry form are live only when the owner publishes them. */
  published: boolean("published").notNull().default(false),
  /** A short introduction shown on the public page. */
  about: text("about"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
  ...softDelete,
});

export const branches = pgTable(
  "branches",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    addressLine: text("address_line"),
    city: text("city").notNull(),
    state: text("state"),
    postalCode: text("postal_code"),
    phone: text("phone"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index("branches_tenant_idx").on(t.tenantId)],
);

export const STAFF_ROLES = ["owner", "manager", "front_desk", "trainer"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** A person's job at an organisation. Empty `branchIds` = every branch. */
export const staffMembers = pgTable(
  "staff_members",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: STAFF_ROLES }).notNull(),
    branchIds: uuid("branch_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    invitedBy: uuid("invited_by"),
    ...timestamps,
  },
  (t) => [
    unique("staff_members_tenant_user").on(t.tenantId, t.userId),
    index("staff_members_user_idx").on(t.userId),
  ],
);

/** An invitation to join an organisation's staff. The token is `<orgId>.<secret>`; only its SHA-256 is stored. */
export const staffInvites = pgTable(
  "staff_invites",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    role: text("role", { enum: STAFF_ROLES }).notNull(),
    branchIds: uuid("branch_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    channel: text("channel", { enum: ["sms", "email"] }).notNull(),
    /** E.164 phone or lower-cased email. */
    destination: text("destination").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedBy: uuid("invited_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_invites_tenant_idx").on(t.tenantId)],
);
