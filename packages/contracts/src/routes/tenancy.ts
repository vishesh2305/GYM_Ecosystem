import { z } from "zod";
import { defineRoute } from "../route";

export const staffRole = z.enum(["owner", "manager", "front_desk", "trainer"]);

/** Any IANA zone or alias. (Intl.supportedValuesOf lists legacy names such as Asia/Calcutta, not Asia/Kolkata.) */
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone");
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
  /** Address of the public gym page. */
  slug: z.string().nullable(),
  published: z.boolean(),
  about: z.string().nullable(),
  /** The platform's business verification of the gym. */
  kycStatus: z.enum(["pending", "verified", "rejected"]),
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
  summary:
    "Change the business name, GSTIN, time zone or public page (slug, about, published) (owner only)",
  tag: "organisations",
  params: orgParams,
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      gstin: gstin.nullable(),
      timezone,
      slug: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lower-case letters, digits and single hyphens")
        .min(3)
        .max(40),
      about: z.string().trim().max(1000).nullable(),
      published: z.boolean(),
    })
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

const inviteParams = z.object({ orgId: z.uuid(), inviteId: z.uuid() });
const staffParams = z.object({ orgId: z.uuid(), staffId: z.uuid() });
const inviteFields = { role: staffRole, branchIds: z.array(z.uuid()).max(100).default([]) };

export const staffInvite = z.object({
  id: z.uuid(),
  role: staffRole,
  branchIds: z.array(z.uuid()),
  channel: z.enum(["sms", "email"]),
  destination: z.string(),
  expiresAt: z.iso.datetime(),
});

export const staffMember = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  role: staffRole,
  branchIds: z.array(z.uuid()),
  status: z.enum(["active", "suspended"]),
  joinedAt: z.iso.datetime(),
});

export const inviteStaff = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/invites",
  summary:
    "Invite someone to the staff by SMS or email (owners: any role; managers: front desk and trainers)",
  tag: "staff",
  params: orgParams,
  body: z.discriminatedUnion("channel", [
    z.object({
      channel: z.literal("sms"),
      phone: z.string().trim().min(3).max(32),
      ...inviteFields,
    }),
    z.object({ channel: z.literal("email"), email: z.email().max(254), ...inviteFields }),
  ]),
  response: staffInvite,
  status: 201,
});

export const listInvites = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/invites",
  summary: "Invites that are still waiting to be accepted",
  tag: "staff",
  params: orgParams,
  response: z.array(staffInvite),
});

export const revokeInvite = defineRoute({
  method: "DELETE",
  path: "/v1/orgs/{orgId}/invites/{inviteId}",
  summary: "Cancel an invite",
  tag: "staff",
  params: inviteParams,
  response: z.undefined(),
  status: 204,
});

export const acceptInvite = defineRoute({
  method: "POST",
  path: "/v1/invites/accept",
  summary: "Join a gym's staff with an invite sent to my phone or email",
  tag: "staff",
  body: z.object({ token: z.string().min(10).max(200) }),
  response: organisation,
});

export const listStaff = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/staff",
  summary: "Everyone on the staff (owners and managers)",
  tag: "staff",
  params: orgParams,
  response: z.array(staffMember),
});

export const updateStaff = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}/staff/{staffId}",
  summary:
    "Change a staff member's role, branches or status (owner only; a gym always keeps one owner)",
  tag: "staff",
  params: staffParams,
  body: z
    .object({
      role: staffRole,
      branchIds: z.array(z.uuid()).max(100),
      status: z.enum(["active", "suspended"]),
    })
    .partial(),
  response: staffMember,
});

export const removeStaff = defineRoute({
  method: "DELETE",
  path: "/v1/orgs/{orgId}/staff/{staffId}",
  summary: "Remove someone from the staff (owner only; a gym always keeps one owner)",
  tag: "staff",
  params: staffParams,
  response: z.undefined(),
  status: 204,
});
