import { z } from "zod";
import { defineRoute } from "../route";

const orgParams = z.object({ orgId: z.uuid() });
/** Calendar dates in the gym's time zone, both included; default the last 30 days; at most 366 days. */
const dateRange = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });

export const revenueReport = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/reports/revenue",
  summary: "Money collected and refunded per day and by payment method, in the gym's time zone",
  tag: "reports",
  params: orgParams,
  query: dateRange,
  response: z.object({
    from: z.iso.date(),
    to: z.iso.date(),
    collectedPaise: z.number().int(),
    refundedPaise: z.number().int(),
    netPaise: z.number().int(),
    byDay: z.array(
      z.object({
        date: z.iso.date(),
        collectedPaise: z.number().int(),
        refundedPaise: z.number().int(),
      }),
    ),
    byMethod: z.array(z.object({ method: z.string(), collectedPaise: z.number().int() })),
  }),
});

export const duesReport = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/reports/dues",
  summary: "Unpaid invoices today, grouped by how many days past their due date",
  tag: "reports",
  params: orgParams,
  response: z.object({
    asOf: z.iso.date(),
    duePaise: z.number().int(),
    invoices: z.number().int(),
    buckets: z.array(
      z.object({
        bucket: z.enum(["not_due", "1_30", "31_60", "61_90", "90_plus"]),
        invoices: z.number().int(),
        duePaise: z.number().int(),
      }),
    ),
  }),
});

export const attendanceReport = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/reports/attendance",
  summary:
    "Visits by weekday (0 = Sunday) and hour in the gym's time zone, for a heatmap of busy times",
  tag: "reports",
  params: orgParams,
  query: dateRange.extend({ branchId: z.uuid().optional() }),
  response: z.object({
    from: z.iso.date(),
    to: z.iso.date(),
    visits: z.number().int(),
    members: z.number().int(),
    heatmap: z.array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
        visits: z.number().int(),
      }),
    ),
  }),
});

export const retentionReport = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/reports/retention",
  summary:
    "Members grouped by the month they first started; retained[k] = how many still had a membership k months later",
  tag: "reports",
  params: orgParams,
  query: z.object({ months: z.coerce.number().int().min(1).max(24).optional() }),
  response: z.object({
    cohorts: z.array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        members: z.number().int(),
        retained: z.array(z.number().int()),
      }),
    ),
  }),
});
