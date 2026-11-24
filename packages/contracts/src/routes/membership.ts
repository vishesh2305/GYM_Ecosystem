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

const memberParams = z.object({ orgId: z.uuid(), memberId: z.uuid() });
const pastDate = z.iso
  .date()
  .refine((d) => d <= new Date().toISOString().slice(0, 10), "Date must not be in the future");

const memberBase = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(3).max(32),
  email: z.email().max(254),
  gender: z.enum(["female", "male", "other", "unspecified"]),
  dateOfBirth: pastDate,
  homeBranchId: z.uuid(),
  emergencyContactName: z.string().trim().max(120),
  emergencyContactPhone: z.string().trim().min(3).max(32),
  notes: z.string().trim().max(2000),
});

export const member = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  gender: memberBase.shape.gender.nullable(),
  dateOfBirth: z.string().nullable(),
  homeBranchId: z.uuid(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  source: z.enum(["manual", "import", "app"]),
  createdAt: z.iso.datetime(),
});

export const listMembers = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/members",
  summary: "Find members by name or phone, newest first, a page at a time",
  tag: "members",
  params: orgParams,
  query: z.object({
    q: z.string().trim().max(100).optional(),
    branchId: z.uuid().optional(),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  response: z.object({ items: z.array(member), nextCursor: z.uuid().nullable() }),
});

export const createMember = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/members",
  summary: "Add a member (owner, manager or front desk)",
  tag: "members",
  params: orgParams,
  body: memberBase.partial().required({ name: true, homeBranchId: true }),
  response: member,
  status: 201,
});

export const getMember = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/members/{memberId}",
  summary: "One member",
  tag: "members",
  params: memberParams,
  response: member,
});

export const updateMember = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}/members/{memberId}",
  summary: "Change a member's details (owner, manager or front desk)",
  tag: "members",
  params: memberParams,
  body: memberBase.partial(),
  response: member,
});

export const membershipStatus = z.enum([
  "pending",
  "trial",
  "active",
  "frozen",
  "expired",
  "cancelled",
]);

export const membership = z.object({
  id: z.uuid(),
  memberId: z.uuid(),
  planId: z.uuid(),
  planName: z.string(),
  status: membershipStatus,
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  isTrial: z.boolean(),
  pricePaise: z.number().int(),
  joiningFeePaise: z.number().int(),
  gstPaise: z.number().int(),
  totalPaise: z.number().int(),
  freezesUsed: z.number().int(),
  maxFreezes: z.number().int(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const listMemberships = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/members/{memberId}/memberships",
  summary: "A member's memberships, newest first",
  tag: "memberships",
  params: memberParams,
  response: z.array(membership),
});

export const enrolMember = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/members/{memberId}/memberships",
  summary: "Sign a member up to a plan, from today or a later date (owner, manager or front desk)",
  tag: "memberships",
  params: memberParams,
  body: z.object({ planId: z.uuid(), startDate: z.iso.date().optional() }),
  response: membership,
  status: 201,
});
