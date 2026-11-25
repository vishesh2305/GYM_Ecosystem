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
