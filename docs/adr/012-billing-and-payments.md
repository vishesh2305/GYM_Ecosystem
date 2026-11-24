# 012. Billing, payments and the ledger

- Status: accepted (refines ADR 006)
- Date: 2026-11-25

## Decision

**Ledger.** `ledger_entries` is double-entry and append-only: lines sharing a `journal_id` must balance (deferred
constraint trigger at commit), each line is one-sided, and no role can update or delete rows. Accounts:
receivable (tagged with member id), revenue, gst_cgst, gst_sgst, gst_igst, cash, bank, gateway_clearing.
A member's balance = receivable debits − credits. All postings go through `postJournal` (`assertBalanced`).

**Invoices.** Issued by worker handlers from `membership.created` (free memberships: none). Numbers are gap-free
per gym, kind and Indian financial year (`INV/26-27/000001`, `CN/26-27/000001`, ≤ 16 characters) using a
row-locked series row. Supplies at the gym are treated as intra-state: GST is split equally into CGST and SGST
(odd paisa to CGST). Lines carry SAC `999723`, to be confirmed with the gym's accountant. Seller name, GSTIN,
buyer name and place of supply are copied at issue time. Plan changes produce a credit note for the credited
amount plus GST at the old rate. Journals: invoice Dr receivable / Cr revenue, CGST, SGST; credit note reversed.

**Payments.** Desk payments (cash, UPI-to-QR, card terminal) require an Idempotency-Key, lock the invoice row, may
not exceed what is due, and post Dr cash/bank, Cr receivable. Online payments: `pay-online` creates a pending
payment and a gateway order whose notes carry tenant and payment ids. The Razorpay webhook is accepted only with a
valid HMAC-SHA256 signature over the raw body; the payment must match notes + order id; captured events apply once
(row lock, status check); failed never overrides captured; an amount mismatch is ignored and logged; money that
would overpay an invoice is kept as captured but unapplied and audited (`payment.unapplied`) for a refund.

**Refunds.** Owners and managers, Idempotency-Key, payment row locked, total refunds ≤ amount paid, online money
refunded through the gateway first. Journal Dr receivable / Cr cash, bank or clearing; the invoice reopens.

**Reminders.** Hourly per gym: reminders on the due date, +2 and +5 days (`invoice.payment_reminder` events, each
step claimed with a conditional update so concurrent runs never duplicate), and after `DUNNING_GRACE_DAYS` the
unpaid membership expires. Delivery (SMS, WhatsApp, email) comes with notifications (A14).

**Gateways.** `PaymentGateway` port: Razorpay REST adapter (orders, refunds) and a fake adapter for development;
production refuses the fake gateway and the default webhook secret.

## Not yet done

- UPI AutoPay / recurring mandates (register mandate, confirm by webhook, charge on renewal, retries): next step.
- Settlement reconciliation (gateway_clearing → bank) and IGST for inter-state B2B buyers.
- Member-facing payment from the app (needs member accounts linked to member records).
