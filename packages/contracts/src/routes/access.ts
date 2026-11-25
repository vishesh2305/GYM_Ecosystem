import { z } from "zod";
import { defineRoute } from "../route";

export const listMyGyms = defineRoute({
  method: "GET",
  path: "/v1/me/gyms",
  summary:
    "Gyms where I am a member: members whose phone number matches my verified phone are linked to me",
  tag: "me",
  response: z.array(
    z.object({ orgId: z.uuid(), orgName: z.string(), memberId: z.uuid(), memberName: z.string() }),
  ),
});

const myGymParams = z.object({ orgId: z.uuid() });

export const getMyPass = defineRoute({
  method: "GET",
  path: "/v1/me/gyms/{orgId}/pass",
  summary:
    "My gym pass: the app shows qrPrefix + the current TOTP code as a QR code, which changes every period seconds and works offline",
  tag: "me",
  params: myGymParams,
  response: z.object({
    memberId: z.uuid(),
    secret: z.string(),
    algorithm: z.literal("SHA1"),
    digits: z.literal(8),
    period: z.literal(30),
    qrPrefix: z.string(),
  }),
});
