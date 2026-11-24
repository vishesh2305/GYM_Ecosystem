import { z } from "zod";
import { defineRoute } from "../route";

export const staffRole = z.enum(["owner", "manager", "front_desk", "trainer"]);

const timezone = z
  .string()
  .refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "Unknown time zone");
/** Indian GSTIN: 2-digit state, PAN, entity number, Z, check character. */
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");

const branchInput = z.object({
  name: z.string().trim().min(1).max(100),
  addressLine: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(32).optional(),
});

export const organisation = z.object({
  id: z.uuid(),
  name: z.string(),
  gstin: z.string().nullable(),
  countryCode: z.string(),
  currency: z.string(),
  timezone: z.string(),
  createdAt: z.iso.datetime(),
  myRole: staffRole,
});

export const branch = z.object({
  id: z.uuid(),
  name: z.string(),
  addressLine: z.string().nullable(),
  city: z.string(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const orgParams = z.object({ orgId: z.uuid() });
const branchParams = z.object({ orgId: z.uuid(), branchId: z.uuid() });

export const createOrganisation = defineRoute({
  method: "POST",
  path: "/v1/orgs",
  summary: "Register a gym business with its first branch (the creator becomes its owner)",
  tag: "organisations",
  body: z.object({
    name: z.string().trim().min(2).max(120),
    gstin: gstin.optional(),
    timezone: timezone.optional(),
    branch: branchInput,
  }),
  response: z.object({ organisation, branch }),
  status: 201,
});

export const listMyOrganisations = defineRoute({
  method: "GET",
  path: "/v1/orgs",
  summary: "Gym businesses I work at, with my role",
  tag: "organisations",
  response: z.array(organisation),
});

export const getOrganisation = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}",
  summary: "One gym business",
  tag: "organisations",
  params: orgParams,
  response: organisation,
});

export const updateOrganisation = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}",
  summary: "Change the business name, GSTIN or time zone (owner only)",
  tag: "organisations",
  params: orgParams,
  body: z
    .object({ name: z.string().trim().min(2).max(120), gstin: gstin.nullable(), timezone })
    .partial(),
  response: organisation,
});

export const listBranches = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/branches",
  summary: "Branches I can work at",
  tag: "organisations",
  params: orgParams,
  response: z.array(branch),
});

export const createBranch = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/branches",
  summary: "Open a new branch (owner or manager)",
  tag: "organisations",
  params: orgParams,
  body: branchInput,
  response: branch,
  status: 201,
});

export const updateBranch = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}/branches/{branchId}",
  summary: "Change a branch's details (owner or manager)",
  tag: "organisations",
  params: branchParams,
  body: branchInput.partial(),
  response: branch,
});
