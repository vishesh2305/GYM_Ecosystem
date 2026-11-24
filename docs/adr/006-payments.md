# 006. Payments behind a port

- Status: accepted
- Date: 2026-11-24

## Decision

- `PaymentGateway` port in billing; first adapter Razorpay (orders, UPI AutoPay mandates, refunds, Route payouts). Stripe adapter later for other markets.
- Hosted checkout and tokens only: card data never touches our servers (PCI DSS SAQ-A).
- Every webhook signature-verified and processed idempotently; double-entry ledger is the source of truth for balances.
- Digital premium subscriptions in the apps use store in-app purchase (RevenueCat); gym memberships and physical goods use the gateway.

## Consequences

A second gateway can be added without touching billing logic.
