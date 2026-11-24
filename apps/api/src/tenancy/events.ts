import { z } from "zod";
import { defineEvent } from "../platform/events";

export const organisationCreated = defineEvent(
  "organisation.created",
  z.object({ organisationId: z.uuid(), ownerUserId: z.uuid() }),
);
