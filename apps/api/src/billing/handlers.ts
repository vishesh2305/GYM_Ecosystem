import { membershipCreated, membershipPlanChanged } from "../membership/events";
import { defineHandler } from "../platform/events";
import { issueMembershipInvoice, issuePlanChangeCreditNote } from "./invoicing";

export const invoiceMembershipSale = defineHandler({
  name: "billing.invoice-membership-sale",
  event: membershipCreated,
  async handle(sale, { tx, event }) {
    await issueMembershipInvoice(tx, event.tenantId ?? "", sale);
  },
});

export const creditNoteForPlanChange = defineHandler({
  name: "billing.credit-note-for-plan-change",
  event: membershipPlanChanged,
  async handle(change, { tx, event }) {
    await issuePlanChangeCreditNote(tx, event.tenantId ?? "", change);
  },
});
