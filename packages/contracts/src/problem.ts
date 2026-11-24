import { z } from "zod";

/** RFC 9457 problem details, as returned by every non-2xx API response. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
