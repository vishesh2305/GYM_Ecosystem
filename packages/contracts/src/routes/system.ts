import { z } from "zod";
import { defineRoute } from "../route";

export const health = defineRoute({
  method: "GET",
  path: "/v1/health",
  summary: "Liveness: the process is up",
  tag: "system",
  response: z.object({ status: z.literal("ok") }),
});

export const ready = defineRoute({
  method: "GET",
  path: "/v1/ready",
  summary: "Readiness: database and cache are reachable",
  tag: "system",
  response: z.object({
    status: z.literal("ok"),
    checks: z.object({ database: z.literal("ok"), cache: z.literal("ok") }),
  }),
});
