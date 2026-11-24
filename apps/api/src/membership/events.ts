import { z } from "zod";
import { defineEvent } from "../platform/events";

/** Sold: billing (step A10) turns this into an invoice. Amounts in paise. */
export const membershipCreated = defineEvent(
  "membership.created",
  z.object({
    membershipId: z.uuid(),
    memberId: z.uuid(),
    planId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    pricePaise: z.number().int(),
    joiningFeePaise: z.number().int(),
    gstRateBps: z.number().int(),
    gstPaise: z.number().int(),
    totalPaise: z.number().int(),
  }),
);

/** Plan changed: billing credits the unused value of the old plan against the new one. */
export const membershipPlanChanged = defineEvent(
  "membership.plan_changed",
  z.object({
    oldMembershipId: z.uuid(),
    newMembershipId: z.uuid(),
    memberId: z.uuid(),
    creditPaise: z.number().int(),
  }),
);
