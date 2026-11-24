import { z } from "zod";
import { defineRoute } from "../route";

const paise = z.number().int().min(0).max(1_000_000_000);
const orgParams = z.object({ orgId: z.uuid() });

const gstRate = z.union([
  z.literal(0),
  z.literal(500),
  z.literal(1200),
  z.literal(1800),
  z.literal(2800),
]);

/** Plan fields without defaults: safe to use for partial updates (defaults would overwrite stored values). */
const planBase = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  durationUnit: z.enum(["day", "month"]),
  durationCount: z.number().int().min(1).max(365),
  /** Before GST, in paise (₹1 = 100 paise). */
  pricePaise: paise,
  gstRateBps: gstRate,
  joiningFeePaise: paise,
  isTrial: z.boolean(),
  branchIds: z.array(z.uuid()).max(100),
  maxFreezes: z.number().int().min(0).max(12),
  maxFreezeDays: z.number().int().min(0).max(180),
});

const newPlan = planBase.extend({
  gstRateBps: gstRate.default(1800),
  joiningFeePaise: paise.default(0),
  isTrial: z.boolean().default(false),
  branchIds: planBase.shape.branchIds.default([]),
  maxFreezes: planBase.shape.maxFreezes.default(0),
  maxFreezeDays: planBase.shape.maxFreezeDays.default(0),
});

export const plan = planBase.extend({
  id: z.uuid(),
  description: z.string().nullable(),
  active: z.boolean(),
  /** What a member pays: price + joining fee + GST. */
  totalPaise: z.number().int(),
  gstPaise: z.number().int(),
});

export const listPlans = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/plans",
  summary: "Membership plans (active ones unless includeArchived=true)",
  tag: "plans",
  params: orgParams,
  query: z.object({ includeArchived: z.stringbool().optional() }),
  response: z.array(plan),
});

export const createPlan = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/plans",
  summary: "Create a membership plan (owner or manager)",
  tag: "plans",
  params: orgParams,
  body: newPlan.refine((p) => p.durationUnit === "day" || p.durationCount <= 36, {
    message: "A plan can last at most 36 months",
    path: ["durationCount"],
  }),
  response: plan,
  status: 201,
});

export const updatePlan = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}/plans/{planId}",
  summary: "Change or archive a plan; members already signed up keep the terms they bought",
  tag: "plans",
  params: z.object({ orgId: z.uuid(), planId: z.uuid() }),
  body: planBase
    .omit({ durationUnit: true, durationCount: true })
    .extend({ active: z.boolean() })
    .partial(),
  response: plan,
});
