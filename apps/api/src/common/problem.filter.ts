import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { toProblem } from "./problem";

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblem(exception, request.id);
    if (problem.status >= 500) request.log.error({ err: exception }, "request failed");
    if (problem.status === 401) void reply.header("www-authenticate", "Bearer");
    void reply.status(problem.status).type("application/problem+json").send(problem);
  }
}
