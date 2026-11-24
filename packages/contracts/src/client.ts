import type { z } from "zod";
import { problemSchema, type Problem } from "./problem";
import type { Route } from "./route";

type Part<K extends string, S> = S extends z.ZodType ? { [P in K]: z.input<S> } : unknown;
export type RouteInput<R extends Route> = Part<"params", R["params"]> &
  Part<"query", R["query"]> &
  Part<"body", R["body"]>;
type Args<R extends Route> = keyof RouteInput<R> extends never ? [] : [input: RouteInput<R>];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
  ) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

interface RawInput {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/** Typed API client driven by the shared route contracts. Responses are validated against the contract. */
export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  return async function call<R extends Route>(
    route: R,
    ...args: Args<R>
  ): Promise<z.output<R["response"]>> {
    const input = (args[0] ?? {}) as RawInput;
    const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = input.params?.[name];
      if (value === undefined || value === null)
        throw new TypeError(`Missing path parameter "${name}"`);
      return encodeURIComponent(String(value));
    });

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {})) {
      for (const v of Array.isArray(value) ? value : [value])
        if (v !== undefined) query.append(key, String(v));
    }
    const qs = query.toString();

    const headers: Record<string, string> = {
      accept: "application/json",
      ...(await options.headers?.()),
    };
    if (input.body !== undefined) headers["content-type"] = "application/json";

    const res = await doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
      method: route.method,
      headers,
      ...(input.body !== undefined && { body: JSON.stringify(input.body) }),
    });

    if (!res.ok) {
      const body: unknown = await res.json().catch(() => undefined);
      const problem = problemSchema.safeParse(body);
      throw new ApiError(res.status, problem.success ? problem.data : undefined);
    }
    const data: unknown = res.status === 204 ? undefined : await res.json();
    return route.response.parse(data) as z.output<R["response"]>;
  };
}
