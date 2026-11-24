import { z } from "zod";
import { defineRoute } from "../route";

const me = z.object({
  id: z.uuid(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const getMe = defineRoute({
  method: "GET",
  path: "/v1/me",
  summary: "My profile",
  tag: "me",
  response: me,
});

export const updateMe = defineRoute({
  method: "PATCH",
  path: "/v1/me",
  summary: "Update my profile",
  tag: "me",
  body: z.object({ name: z.string().trim().min(1).max(100) }).partial(),
  response: me,
});
