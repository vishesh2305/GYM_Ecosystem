import { z } from "zod";
import { defineRoute } from "../route";

const kycStatus = z.enum(["pending", "verified", "rejected"]);

export const adminGym = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string().nullable(),
  published: z.boolean(),
  kycStatus,
  kycNote: z.string().nullable(),
  kycReviewedAt: z.iso.datetime().nullable(),
  branches: z.number().int(),
  members: z.number().int(),
  owners: z.array(
    z.object({
      name: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
    }),
  ),
  createdAt: z.iso.datetime(),
});

export const listAdminGyms = defineRoute({
  method: "GET",
  path: "/v1/admin/gyms",
  summary:
    "Platform admins: every gym with its onboarding (KYC) status, size and owners, newest first",
  tag: "admin",
  query: z.object({
    q: z.string().trim().min(1).max(60).optional(),
    kycStatus: kycStatus.optional(),
  }),
  response: z.array(adminGym),
});

export const reviewGymKyc = defineRoute({
  method: "PATCH",
  path: "/v1/admin/gyms/{gymId}/kyc",
  summary: "Platform admins: record the outcome of a gym's business verification (KYC)",
  tag: "admin",
  params: z.object({ gymId: z.uuid() }),
  body: z.object({ status: kycStatus, note: z.string().trim().max(500).optional() }),
  response: adminGym,
});

export const featureFlag = z.object({
  key: z.string(),
  description: z.string(),
  /** For everyone not listed and outside the rollout share. */
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  tenantIds: z.array(z.uuid()),
  userIds: z.array(z.uuid()),
});

export const listFeatureFlags = defineRoute({
  method: "GET",
  path: "/v1/admin/flags",
  summary: "Platform admins: feature switches",
  tag: "admin",
  response: z.array(featureFlag),
});

export const setFeatureFlag = defineRoute({
  method: "PUT",
  path: "/v1/admin/flags/{key}",
  summary:
    "Platform admins: create or change a feature switch (on for listed gyms and people, plus a share of everyone)",
  tag: "admin",
  params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/) }),
  body: featureFlag.omit({ key: true }),
  response: featureFlag,
});
