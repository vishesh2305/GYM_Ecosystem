import "reflect-metadata";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { Type } from "@nestjs/common";
import type { IncomingMessage } from "node:http";
import { v7 } from "uuid";
import { AppModule } from "./app.module";
import { TokenService } from "./auth/token.service";
import { ProblemFilter } from "./common/problem.filter";
import type { ApiEnv } from "./env";
import { createRedis } from "./infra.module";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface CreateAppOptions {
  /** Extra Nest modules (tests mount test-only controllers this way). */
  modules?: Type[];
}

/** Build a fully configured, initialised app. Used by main.ts and by the e2e tests. */
export async function createApp(env: ApiEnv, options: CreateAppOptions = {}) {
  const adapter = new FastifyAdapter({
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY,
    requestIdHeader: false,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : v7();
    },
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
  });

  const fastify = adapter.getInstance();
  const served = new Set<string>();
  fastify.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      if (method !== "HEAD") served.add(`${method} ${route.url}`);
  });

  const redis = createRedis(env.REDIS_URL);
  const app = await NestFactory.create(
    AppModule.forRoot(env, redis, options.modules),
    adapter,
    env.NODE_ENV === "test" ? { logger: false } : { bufferLogs: true },
  );

  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProblemFilter());

  fastify.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
  const tokens = app.get(TokenService);
  await app.register(rateLimit, {
    // Signed-in callers are limited per person (a verified token), everyone else per address.
    keyGenerator: async (request) => {
      const [scheme, token] = (request.headers.authorization ?? "").split(" ");
      if (scheme === "Bearer" && token) {
        const auth = await tokens.verifyAccess(token).catch(() => undefined);
        if (auth) return `user:${auth.userId}`;
      }
      return `ip:${request.ip}`;
    },
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    redis,
    nameSpace: "rl:api:",
    // Fail open if Redis is down: availability over strict limiting; /v1/ready reports the outage.
    skipOnError: true,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Rate limit exceeded, retry in ${context.after}`), {
        statusCode: context.statusCode,
      }),
  });

  await app.init();
  await fastify.ready();
  return { app, routes: served as ReadonlySet<string> };
}
