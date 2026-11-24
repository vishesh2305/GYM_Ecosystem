import { z } from "zod";
import { defineRoute } from "../route";

export const consentPurpose = z.enum([
  "terms",
  "privacy",
  "health_data",
  "marketing_sms",
  "marketing_email",
  "marketing_whatsapp",
]);

const consentState = z.object({
  purpose: consentPurpose,
  granted: z.boolean(),
  policyVersion: z.string(),
  decidedAt: z.iso.datetime(),
});

export const listConsents = defineRoute({
  method: "GET",
  path: "/v1/me/consents",
  summary: "My current choice for each consent purpose",
  tag: "me",
  response: z.array(consentState),
});

export const recordConsent = defineRoute({
  method: "POST",
  path: "/v1/me/consents",
  summary: "Give or withdraw consent for one purpose (kept as history)",
  tag: "me",
  body: z.object({
    purpose: consentPurpose,
    granted: z.boolean(),
    policyVersion: z.string().trim().min(1).max(40),
  }),
  response: consentState,
  status: 201,
});
