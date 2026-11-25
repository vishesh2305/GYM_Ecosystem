import { z } from "zod";
import { defineRoute } from "../route";

export const registerDevice = defineRoute({
  method: "POST",
  path: "/v1/me/devices",
  summary:
    "Register this phone for push notifications (an Expo push token). A token used by someone else before moves to me",
  tag: "notifications",
  body: z.object({
    token: z.string().trim().min(10).max(200),
    platform: z.enum(["ios", "android"]),
  }),
  response: z.object({ id: z.uuid() }),
  status: 201,
});

export const removeDevice = defineRoute({
  method: "DELETE",
  path: "/v1/me/devices/{deviceId}",
  summary: "Stop push notifications to this phone (call on sign-out)",
  tag: "notifications",
  params: z.object({ deviceId: z.uuid() }),
  response: z.undefined(),
  status: 204,
});

export const listMemberNotifications = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/members/{memberId}/notifications",
  summary: "Messages sent (or waiting to be sent) to a member, newest first, with the channel used",
  tag: "notifications",
  params: z.object({ orgId: z.uuid(), memberId: z.uuid() }),
  response: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      status: z.enum(["pending", "sent", "failed", "skipped"]),
      channel: z.enum(["push", "whatsapp", "sms", "email"]).nullable(),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      sendAfter: z.iso.datetime(),
      sentAt: z.iso.datetime().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
