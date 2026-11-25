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

export const kiosk = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  name: z.string(),
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const createKiosk = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/branches/{branchId}/kiosks",
  summary:
    "Register a check-in device at a branch. The token is shown only once; the device sends it as x-kiosk-token",
  tag: "access",
  params: z.object({ orgId: z.uuid(), branchId: z.uuid() }),
  body: z.object({ name: z.string().trim().min(1).max(60) }),
  response: kiosk.extend({ token: z.string() }),
  status: 201,
});

export const listKiosks = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/kiosks",
  summary: "Check-in devices that are still allowed in",
  tag: "access",
  params: z.object({ orgId: z.uuid() }),
  response: z.array(kiosk),
});

export const revokeKiosk = defineRoute({
  method: "DELETE",
  path: "/v1/orgs/{orgId}/kiosks/{kioskId}",
  summary: "Stop a check-in device from working (for example when it is lost)",
  tag: "access",
  params: z.object({ orgId: z.uuid(), kioskId: z.uuid() }),
  response: z.undefined(),
  status: 204,
});

export const getKiosk = defineRoute({
  method: "GET",
  path: "/v1/kiosk",
  summary: "For check-in devices: which device and branch this x-kiosk-token belongs to",
  tag: "access",
  response: z.object({ id: z.uuid(), orgId: z.uuid(), branchId: z.uuid(), name: z.string() }),
});
