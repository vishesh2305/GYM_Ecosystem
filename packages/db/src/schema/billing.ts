import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../columns";
import { organisations } from "./tenancy";

export const LEDGER_ACCOUNTS = [
  "receivable",
  "revenue",
  "gst_cgst",
  "gst_sgst",
  "gst_igst",
  "cash",
  "bank",
  "gateway_clearing",
] as const;

/**
 * Double-entry ledger. Lines sharing a journal_id must balance (checked by a deferred trigger at commit) and
 * rows can never be changed or deleted: corrections are new, reversing journals.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    journalId: uuid("journal_id").notNull(),
    account: text("account", { enum: LEDGER_ACCOUNTS }).notNull(),
    memberId: uuid("member_id"),
    debitPaise: integer("debit_paise").notNull().default(0),
    creditPaise: integer("credit_paise").notNull().default(0),
    /** What caused it, e.g. ("invoice", id) or ("payment", id). */
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    memo: text("memo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_entries_journal_idx").on(t.journalId),
    index("ledger_entries_member_idx").on(t.tenantId, t.memberId, t.account),
    check(
      "ledger_entries_one_sided",
      sql`(${t.debitPaise} > 0 and ${t.creditPaise} = 0) or (${t.creditPaise} > 0 and ${t.debitPaise} = 0)`,
    ),
  ],
);
