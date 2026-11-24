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
