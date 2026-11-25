import { z } from "zod";
import { defineRoute } from "../route";

export const privacyRequest = z.object({
  id: z.uuid(),
  kind: z.enum(["export", "erasure"]),
  status: z.enum(["pending", "done", "failed"]),
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  /** Exports can be downloaded until then. */
  expiresAt: z.iso.datetime().nullable(),
});

export const requestDataExport = defineRoute({
  method: "POST",
  path: "/v1/me/privacy/exports",
  summary:
    "Ask for a copy of all the personal data held about me, across every gym; ready within minutes, kept 7 days. " +
    "Asking again within a day returns the same request",
  tag: "privacy",
  response: privacyRequest,
  status: 202,
});

export const listPrivacyRequests = defineRoute({
  method: "GET",
  path: "/v1/me/privacy/requests",
  summary: "My data export and erasure requests, newest first",
  tag: "privacy",
  response: z.array(privacyRequest),
});

export const downloadDataExport = defineRoute({
  method: "GET",
  path: "/v1/me/privacy/exports/{requestId}",
  summary: "Download a finished export as JSON (409 while it is being prepared, 410 once expired)",
  tag: "privacy",
  params: z.object({ requestId: z.uuid() }),
  response: z.record(z.string(), z.unknown()),
});

export const requestErasure = defineRoute({
  method: "POST",
  path: "/v1/me/privacy/erasure",
  summary:
    "Delete my account and personal data in every gym. Signs out everywhere at once; erasure follows within " +
    "minutes. Records the law requires (tax invoices, payments) are kept with my name removed from my member " +
    "records. A gym's only owner must hand over ownership first",
  tag: "privacy",
  body: z.object({ confirm: z.literal("DELETE MY ACCOUNT") }),
  response: privacyRequest,
  status: 202,
});
