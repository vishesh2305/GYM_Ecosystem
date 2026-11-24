import { z } from "zod";
import { defineEvent } from "../platform/events";

export const userRegistered = defineEvent(
  "user.registered",
  z.object({ userId: z.uuid(), via: z.enum(["sms", "email", "google", "apple"]) }),
);
