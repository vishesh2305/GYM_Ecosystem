import { withTenant, type DbHandle } from "@gym/db";
import { BadRequestException, Body, Controller, Get, Inject, Module, Post } from "@nestjs/common";
import { v7 } from "uuid";
import { z } from "zod";
import { Public } from "../src/auth/auth.guard";
import { ZodPipe } from "../src/common/zod.pipe";
import { appendEvent, defineEvent } from "../src/platform/events";
import { RequireIdempotencyKey } from "../src/platform/idempotency";
import { DB } from "../src/tokens";

const echoBody = z.object({ name: z.string().min(2), age: z.number().int().optional() });
const chargeBody = z.object({ amount: z.number().int().positive() });
const pingBody = z.object({
  tenantId: z.uuid(),
  message: z.string(),
  event: z.enum(["pinged", "doomed"]).default("pinged"),
});

export const testPinged = defineEvent("test.pinged", z.object({ message: z.string() }));
export const testDoomed = defineEvent("test.doomed", z.object({ message: z.string() }));

/** Shared state the tests read to count side effects. */
export const testState = { charges: 0, failNext: false };

// Test-only routes, mounted under /v1/_test, to exercise platform behaviour end to end.
@Public()
@Controller("_test")
class TestController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post("echo")
  echo(@Body(new ZodPipe(echoBody)) body: z.output<typeof echoBody>) {
    return body;
  }

  @Get("boom")
  boom(): never {
    throw new Error("database password is hunter2");
  }

  @Post("charge")
  @RequireIdempotencyKey()
  async charge(@Body(new ZodPipe(chargeBody)) body: z.output<typeof chargeBody>) {
    if (testState.failNext) {
      testState.failNext = false;
      throw new BadRequestException("gateway declined");
    }
    await new Promise((r) => setTimeout(r, body.amount === 999 ? 400 : 0));
    testState.charges += 1;
    return { chargeId: v7(), amount: body.amount, count: testState.charges };
  }

  @Post("note")
  note(@Body() body: unknown) {
    testState.charges += 1;
    return { received: body };
  }

  @Post("ping")
  async ping(@Body(new ZodPipe(pingBody)) body: z.output<typeof pingBody>) {
    const event = body.event === "doomed" ? testDoomed : testPinged;
    const eventId = await withTenant(this.db.db, body.tenantId, (tx) =>
      appendEvent(tx, event, { message: body.message }, body.tenantId),
    );
    return { eventId };
  }
}

@Module({ controllers: [TestController] })
export class TestModule {}
