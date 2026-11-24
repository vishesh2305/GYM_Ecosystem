import type { DbHandle } from "@gym/db";
import { idempotencyKeys } from "@gym/db/schema";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  SetMetadata,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { and, eq, isNull } from "@gym/db/orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { catchError, from, mergeMap, of, switchMap, throwError, type Observable } from "rxjs";
import { DB } from "../tokens";

const REQUIRE_KEY = "idempotency:required";
const KEY_FORMAT = /^[\x21-\x7E]{1,255}$/;
const STALE_AFTER_MS = 60_000;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Mark a route (money or access writes) so it rejects requests without an Idempotency-Key header. */
export const RequireIdempotencyKey = () => SetMetadata(REQUIRE_KEY, true);

export const requestHash = (method: string, url: string, body: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([method, url, body ?? null]))
    .digest("hex");

// shortcut: scoped by client IP until auth exists; A7 switches this to the authenticated principal.
const scopeOf = (request: FastifyRequest) => `ip:${request.ip}`;

type Begin = { run: true } | { run: false; body: unknown };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    if (!UNSAFE.has(request.method)) return next.handle();

    const key = request.headers["idempotency-key"];
    const required = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (key === undefined) {
      if (required)
        throw new BadRequestException("Idempotency-Key header is required for this operation");
      return next.handle();
    }
    if (typeof key !== "string" || !KEY_FORMAT.test(key)) {
      throw new BadRequestException("Idempotency-Key must be 1-255 visible ASCII characters");
    }

    const scope = scopeOf(request);
    const hash = requestHash(request.method, request.url, request.body);
    const status =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (request.method === "POST" ? 201 : 200);

    return from(this.begin(scope, key, hash)).pipe(
      switchMap((state) => {
        if (!state.run) {
          void http.getResponse<FastifyReply>().header("idempotent-replayed", "true");
          return of(state.body);
        }
        return next.handle().pipe(
          mergeMap((body: unknown) =>
            from(this.complete(scope, key, status, body)).pipe(mergeMap(() => of(body))),
          ),
          catchError((error: unknown) =>
            from(this.release(scope, key)).pipe(mergeMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  private async begin(scope: string, key: string, hash: string): Promise<Begin> {
    const { db } = this.db;
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ scope, key, requestHash: hash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length) return { run: true };

    const where = and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key));
    const [row] = await db.select().from(idempotencyKeys).where(where);
    if (!row) throw new ConflictException("Idempotency-Key is being released; retry the request");
    if (row.requestHash !== hash) {
      throw new UnprocessableEntityException(
        "Idempotency-Key was already used with a different request",
      );
    }
    if (row.completedAt) return { run: false, body: row.responseBody };
    if (Date.now() - row.lockedAt.getTime() < STALE_AFTER_MS) {
      throw new ConflictException("A request with this Idempotency-Key is still in progress");
    }
    // The previous holder crashed; take the key over (compare-and-set on locked_at).
    const taken = await db
      .update(idempotencyKeys)
      .set({ lockedAt: new Date() })
      .where(
        and(where, eq(idempotencyKeys.lockedAt, row.lockedAt), isNull(idempotencyKeys.completedAt)),
      )
      .returning({ key: idempotencyKeys.key });
    if (!taken.length)
      throw new ConflictException("A request with this Idempotency-Key is still in progress");
    return { run: true };
  }

  private async complete(
    scope: string,
    key: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    await this.db.db
      .update(idempotencyKeys)
      .set({ statusCode, responseBody: body ?? null, completedAt: new Date() })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
  }

  /** Failed requests free the key so the client can retry. */
  private async release(scope: string, key: string): Promise<void> {
    await this.db.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
  }
}
