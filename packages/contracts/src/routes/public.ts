import { z } from "zod";
import { defineRoute } from "../route";

const slugParams = z.object({ slug: z.string().min(3).max(40) });

/** Everything here is public: only what a gym would put on its own website, never member or staff data. */
export const getPublicGym = defineRoute({
  method: "GET",
  path: "/v1/public/gyms/{slug}",
  summary:
    "A gym's public page: branches and the plans on sale (no sign-in; cached for a few minutes)",
  tag: "public",
  params: slugParams,
  response: z.object({
    name: z.string(),
    slug: z.string(),
    about: z.string().nullable(),
    timezone: z.string(),
    branches: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        addressLine: z.string().nullable(),
        city: z.string(),
        state: z.string().nullable(),
        postalCode: z.string().nullable(),
        phone: z.string().nullable(),
      }),
    ),
    plans: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        description: z.string().nullable(),
        durationUnit: z.enum(["day", "month"]),
        durationCount: z.number().int(),
        pricePaise: z.number().int(),
        joiningFeePaise: z.number().int(),
        gstRateBps: z.number().int(),
        isTrial: z.boolean(),
        /** Empty = every branch. */
        branchIds: z.array(z.uuid()),
      }),
    ),
  }),
});

export const getPublicSchedule = defineRoute({
  method: "GET",
  path: "/v1/public/gyms/{slug}/schedule",
  summary: "Upcoming classes with places left (default the next 7 days, at most 14)",
  tag: "public",
  params: slugParams,
  query: z.object({
    branchId: z.uuid().optional(),
    days: z.coerce.number().int().min(1).max(14).optional(),
  }),
  response: z.array(
    z.object({
      id: z.uuid(),
      branchId: z.uuid(),
      name: z.string(),
      room: z.string().nullable(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      placesLeft: z.number().int(),
    }),
  ),
});

export const createEnquiry = defineRoute({
  method: "POST",
  path: "/v1/public/gyms/{slug}/enquiries",
  summary:
    "The enquiry form on a gym's page: becomes a lead for the gym to call back. Needs consent to be contacted",
  tag: "public",
  params: slugParams,
  body: z.object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(6).max(20),
    email: z.email().max(200).optional(),
    branchId: z.uuid(),
    interest: z.string().trim().max(500).optional(),
    consent: z.literal(true),
  }),
  response: z.object({ received: z.literal(true) }),
  status: 202,
});
