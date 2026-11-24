import { z } from "zod";
import { defineEvent } from "../platform/events";

export const organisationCreated = defineEvent(
  "organisation.created",
  z.object({ organisationId: z.uuid(), ownerUserId: z.uuid() }),
);

export const staffJoined = defineEvent(
  "staff.joined",
  z.object({
    organisationId: z.uuid(),
    userId: z.uuid(),
    role: z.enum(["owner", "manager", "front_desk", "trainer"]),
  }),
);
