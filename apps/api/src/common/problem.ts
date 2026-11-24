import { HttpException } from "@nestjs/common";
import { STATUS_CODES } from "node:http";
import type { Problem } from "@gym/contracts";

export type FieldError = NonNullable<Problem["errors"]>[number];

/** 400 with one entry per invalid field. Thrown by ZodPipe. */
export class ValidationProblem extends HttpException {
  constructor(readonly errors: FieldError[]) {
    super("Validation failed", 400);
  }
}

function statusOf(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" && code >= 400 && code < 600 ? code : 500;
}

/** Map any thrown value to RFC 9457 problem details. 5xx never exposes internal messages. */
export function toProblem(error: unknown, requestId: string): Problem {
  const status = statusOf(error);
  const problem: Problem = {
    type: "about:blank",
    title: STATUS_CODES[status] ?? "Error",
    status,
    requestId,
  };
  if (error instanceof ValidationProblem) problem.errors = error.errors;
  else if (status < 500 || status === 503) {
    const message = error instanceof Error ? error.message : undefined;
    if (message && message !== problem.title) problem.detail = message;
  }
  return problem;
}
