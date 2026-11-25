import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../columns";
import { members } from "./membership";
import { branches, organisations, staffMembers } from "./tenancy";

const tz = { withTimezone: true } as const;

export const LEAD_STAGES = [
  "new",
  "contacted",
  "trial_booked",
  "trial_done",
  "won",
  "lost",
] as const;
export const LEAD_SOURCES = ["walk_in", "phone", "website", "referral", "social", "other"] as const;

/** Someone who might join: from a walk-in, a call or the gym's web page, until they join (won) or not (lost). */
export const leads = pgTable(
  "leads",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    /** E.164. */
    phone: text("phone"),
    email: text("email"),
    source: text("source", { enum: LEAD_SOURCES }).notNull(),
    stage: text("stage", { enum: LEAD_STAGES }).notNull().default("new"),
    assignedTo: uuid("assigned_to").references(() => staffMembers.id),
    /** What they are interested in, in their words. */
    interest: text("interest"),
    trialAt: timestamp("trial_at", tz),
    lostReason: text("lost_reason"),
    /** The member they became. */
    memberId: uuid("member_id").references(() => members.id),
    /** When they agreed to be contacted (website enquiries). */
    consentAt: timestamp("consent_at", tz),
    ...timestamps,
  },
  (t) => [
    index("leads_stage_idx").on(t.tenantId, t.stage, t.createdAt),
    // One open lead per phone number, so a repeated enquiry updates it instead of duplicating it.
    uniqueIndex("leads_open_phone_key")
      .on(t.tenantId, t.phone)
      .where(sql`${t.phone} is not null and ${t.stage} not in ('won', 'lost')`),
  ],
);

/** A follow-up for a lead ("call back Tuesday"), shown to the staff member it is assigned to. */
export const leadTasks = pgTable(
  "lead_tasks",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", tz).notNull(),
    assignedTo: uuid("assigned_to").references(() => staffMembers.id),
    doneAt: timestamp("done_at", tz),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    index("lead_tasks_open_idx")
      .on(t.tenantId, t.dueAt)
      .where(sql`${t.doneAt} is null`),
    index("lead_tasks_lead_idx").on(t.leadId),
  ],
);
