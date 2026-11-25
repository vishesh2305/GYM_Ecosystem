import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id } from "../columns";
import { members, memberships } from "./membership";
import { branches, organisations } from "./tenancy";

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

/** Gap-free numbering per gym, document kind and financial year (the row is locked while a number is taken). */
export const invoiceSeries = pgTable(
  "invoice_series",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["invoice", "credit_note"] }).notNull(),
    fiscalYear: text("fiscal_year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.fiscalYear] })],
);

/** A GST tax invoice or credit note. Amounts in paise. Seller details are copied at issue time. */
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["invoice", "credit_note"] }).notNull(),
    number: text("number").notNull(),
    status: text("status", { enum: ["issued", "partially_paid", "paid", "void"] })
      .notNull()
      .default("issued"),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    membershipId: uuid("membership_id").references(() => memberships.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    /** For a credit note: the invoice it reduces. */
    relatedInvoiceId: uuid("related_invoice_id"),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    sellerName: text("seller_name").notNull(),
    sellerGstin: text("seller_gstin"),
    buyerName: text("buyer_name").notNull(),
    placeOfSupply: text("place_of_supply"),
    taxablePaise: integer("taxable_paise").notNull(),
    cgstPaise: integer("cgst_paise").notNull(),
    sgstPaise: integer("sgst_paise").notNull(),
    igstPaise: integer("igst_paise").notNull().default(0),
    totalPaise: integer("total_paise").notNull(),
    paidPaise: integer("paid_paise").notNull().default(0),
    remindersSent: smallint("reminders_sent").notNull().default(0),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("invoices_tenant_number").on(t.tenantId, t.number),
    index("invoices_member_idx").on(t.tenantId, t.memberId),
    index("invoices_status_due_idx").on(t.tenantId, t.status, t.dueDate),
    check(
      "invoices_amounts",
      sql`${t.totalPaise} = ${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise}`,
    ),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    description: text("description").notNull(),
    /** Services Accounting Code. Default is for fitness centre services; confirm with the gym's accountant. */
    sacCode: text("sac_code").notNull(),
    taxablePaise: integer("taxable_paise").notNull(),
    gstRateBps: smallint("gst_rate_bps").notNull(),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

export const PAYMENT_METHODS = ["cash", "upi_qr", "card_terminal", "online", "autopay"] as const;

/** Money received against an invoice. Online payments start as `pending` until the gateway confirms them. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    method: text("method", { enum: PAYMENT_METHODS }).notNull(),
    status: text("status", { enum: ["pending", "captured", "failed"] }).notNull(),
    amountPaise: integer("amount_paise").notNull(),
    refundedPaise: integer("refunded_paise").notNull().default(0),
    gateway: text("gateway"),
    gatewayOrderId: text("gateway_order_id"),
    gatewayPaymentId: text("gateway_payment_id"),
    reference: text("reference"),
    receivedBy: uuid("received_by"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payments_invoice_idx").on(t.tenantId, t.invoiceId),
    unique("payments_gateway_payment_unique").on(t.gatewayPaymentId),
    unique("payments_gateway_order_unique").on(t.gatewayOrderId),
    check(
      "payments_amounts",
      sql`${t.amountPaise} > 0 and ${t.refundedPaise} between 0 and ${t.amountPaise}`,
    ),
  ],
);

/** Money given back from a payment (through the gateway for online payments, by hand at the desk). */
export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    amountPaise: integer("amount_paise").notNull(),
    reason: text("reason").notNull(),
    gatewayRefundId: text("gateway_refund_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("refunds_payment_idx").on(t.tenantId, t.paymentId),
    check("refunds_positive", sql`${t.amountPaise} > 0`),
  ],
);

export const MANDATE_STATUSES = ["pending", "active", "cancelled", "failed"] as const;

/**
 * A member's UPI AutoPay mandate. `pending` until the member approves it in their UPI app (the first payment
 * is captured with a token), then `active` until cancelled. At most one pending or active mandate per member.
 */
export const autopayMandates = pgTable(
  "autopay_mandates",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    status: text("status", { enum: MANDATE_STATUSES }).notNull(),
    /** Largest single charge the member approved. */
    maxAmountPaise: integer("max_amount_paise").notNull(),
    gateway: text("gateway").notNull(),
    gatewayCustomerId: text("gateway_customer_id").notNull(),
    gatewayOrderId: text("gateway_order_id").notNull(),
    gatewayTokenId: text("gateway_token_id"),
    createdBy: uuid("created_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("autopay_mandates_one_live_per_member")
      .on(t.tenantId, t.memberId)
      .where(sql`${t.status} in ('pending', 'active')`),
    check("autopay_mandates_max_positive", sql`${t.maxAmountPaise} > 0`),
  ],
);
