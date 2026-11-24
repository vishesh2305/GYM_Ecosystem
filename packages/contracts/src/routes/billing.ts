import { z } from "zod";
import { defineRoute } from "../route";

export const invoice = z.object({
  id: z.uuid(),
  kind: z.enum(["invoice", "credit_note"]),
  number: z.string(),
  status: z.enum(["issued", "partially_paid", "paid", "void"]),
  memberId: z.uuid(),
  membershipId: z.uuid().nullable(),
  relatedInvoiceId: z.uuid().nullable(),
  issueDate: z.iso.date(),
  dueDate: z.iso.date(),
  sellerName: z.string(),
  sellerGstin: z.string().nullable(),
  buyerName: z.string(),
  placeOfSupply: z.string().nullable(),
  taxablePaise: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
  totalPaise: z.number().int(),
  paidPaise: z.number().int(),
  lines: z.array(
    z.object({
      description: z.string(),
      sacCode: z.string(),
      taxablePaise: z.number().int(),
      gstRateBps: z.number().int(),
    }),
  ),
});

const memberParams = z.object({ orgId: z.uuid(), memberId: z.uuid() });

export const listMemberInvoices = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/members/{memberId}/invoices",
  summary: "A member's invoices and credit notes, newest first",
  tag: "billing",
  params: memberParams,
  response: z.array(invoice),
});

export const getInvoice = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/invoices/{invoiceId}",
  summary: "One invoice or credit note",
  tag: "billing",
  params: z.object({ orgId: z.uuid(), invoiceId: z.uuid() }),
  response: invoice,
});

export const getMemberBalance = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/members/{memberId}/balance",
  summary: "What a member owes (positive) or has in credit (negative), from the ledger",
  tag: "billing",
  params: memberParams,
  response: z.object({ balancePaise: z.number().int() }),
});

export const payment = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  method: z.enum(["cash", "upi_qr", "card_terminal", "online", "autopay"]),
  status: z.enum(["pending", "captured", "failed"]),
  amountPaise: z.number().int(),
  refundedPaise: z.number().int(),
  reference: z.string().nullable(),
  capturedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const invoiceParams = z.object({ orgId: z.uuid(), invoiceId: z.uuid() });

export const recordPayment = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/invoices/{invoiceId}/payments",
  summary:
    "Record money received at the desk (cash, UPI to the gym's QR, card machine). Needs an Idempotency-Key.",
  tag: "billing",
  params: invoiceParams,
  body: z.object({
    method: z.enum(["cash", "upi_qr", "card_terminal"]),
    amountPaise: z.number().int().min(1).max(1_000_000_000),
    reference: z.string().trim().max(100).optional(),
  }),
  response: payment,
  status: 201,
});

export const listInvoicePayments = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/invoices/{invoiceId}/payments",
  summary: "Payments made against an invoice",
  tag: "billing",
  params: invoiceParams,
  response: z.array(payment),
});

export const startOnlinePayment = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/invoices/{invoiceId}/pay-online",
  summary:
    "Create a payment-gateway order for what is due on an invoice (opened in the app's checkout)",
  tag: "billing",
  params: invoiceParams,
  response: z.object({
    paymentId: z.uuid(),
    gateway: z.enum(["fake", "razorpay"]),
    keyId: z.string(),
    orderId: z.string(),
    amountPaise: z.number().int(),
    currency: z.literal("INR"),
    notes: z.record(z.string(), z.string()),
  }),
  status: 201,
});

export const razorpayWebhook = defineRoute({
  method: "POST",
  path: "/v1/webhooks/razorpay",
  summary: "Razorpay payment events (signature-checked; not for apps)",
  tag: "webhooks",
  body: z.unknown(),
  response: z.object({ received: z.literal(true) }),
});

export const refundPayment = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/payments/{paymentId}/refunds",
  summary:
    "Give money back from a payment (owner or manager). Online payments are refunded through the gateway.",
  tag: "billing",
  params: z.object({ orgId: z.uuid(), paymentId: z.uuid() }),
  body: z.object({
    amountPaise: z.number().int().min(1).max(1_000_000_000),
    reason: z.string().trim().min(2).max(200),
  }),
  response: z.object({
    id: z.uuid(),
    paymentId: z.uuid(),
    amountPaise: z.number().int(),
    gatewayRefundId: z.string().nullable(),
    payment,
  }),
  status: 201,
});

export const getInvoicePdf = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/invoices/{invoiceId}/pdf",
  summary: "Printable PDF of an invoice or credit note (application/pdf)",
  tag: "billing",
  params: z.object({ orgId: z.uuid(), invoiceId: z.uuid() }),
  response: z.unknown(),
});
