import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One API operation. The same object drives server validation, OpenAPI docs and the typed client. */
export interface Route {
  method: HttpMethod;
  /** OpenAPI-style path including the version, e.g. `/v1/members/{memberId}`. */
  path: `/v1/${string}`;
  summary: string;
  tag: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  /** Success status. Default 200. */
  status?: number;
}

export const defineRoute = <const R extends Route>(route: R): R => route;
