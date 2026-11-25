import type { routes } from "@gym/contracts";
import type { branches, organisations, StaffRole } from "@gym/db/schema";
import type { z } from "zod";

export type OrganisationOut = z.output<typeof routes.getOrganisation.response>;
export type BranchOut = z.output<typeof routes.updateBranch.response>;

export const toOrganisation = (
  org: typeof organisations.$inferSelect,
  myRole: StaffRole,
): OrganisationOut => ({
  id: org.id,
  name: org.name,
  gstin: org.gstin,
  countryCode: org.countryCode,
  currency: org.currency,
  timezone: org.timezone,
  slug: org.slug,
  published: org.published,
  about: org.about,
  createdAt: org.createdAt.toISOString(),
  myRole,
});

export const toBranch = (b: typeof branches.$inferSelect): BranchOut => ({
  id: b.id,
  name: b.name,
  addressLine: b.addressLine,
  city: b.city,
  state: b.state,
  postalCode: b.postalCode,
  phone: b.phone,
  createdAt: b.createdAt.toISOString(),
});
