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

**UPI AutoPay.** Staff open `pay-autopay` on an invoice: one checkout pays what is due and asks the member to
approve a mandate up to the invoice total per charge (valid 5 years, frequency "as presented"). The mandate is
`pending` until the webhook captures that payment with a `token_id` (then `active`); a failure or a capture
without a token marks it `failed`. At most one pending or active mandate per member; a new set-up replaces a
pending one and is refused while one is active. Turning it off revokes the token at the gateway first.
Renewals run hourly per gym: an active, non-trial membership ending within 3 days is sold again on the same plan
from the day after it ends (`sellPlan`, no staff, `renewed_by_mandate_id` set), and its invoice is charged to the
mandate (order + recurring payment; the result comes by the same webhook). A charge waiting for its webhook is
never repeated; a refused charge is retried after 20 hours, 3 tries at most. Invoices above the approved limit
are not charged. In every case the reminders and grace-day expiry above still apply to the unpaid invoice.

**Gateways.** `PaymentGateway` port: Razorpay REST adapter (orders, refunds, customers, UPI AutoPay) and a fake
adapter for development; production refuses the fake gateway and the default webhook secret. The adapter is
tested against a local stand-in only: check every call with Razorpay test keys before going live.

## Not yet done

- AutoPay: members cancelling from their UPI app are seen only when the next charge fails (token webhooks are
  not handled yet); a gateway call that succeeds while our transaction then fails leaves an unknown payment that
  the webhook ignores; members turning AutoPay off themselves waits for the member app.
- Settlement reconciliation (gateway_clearing → bank) and IGST for inter-state B2B buyers.
- Member-facing payment from the app (needs member accounts linked to member records).
