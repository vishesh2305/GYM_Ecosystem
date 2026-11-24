import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { z } from "zod";
import { ZodPipe } from "../src/common/zod.pipe";

const echoBody = z.object({ name: z.string().min(2), age: z.number().int().optional() });

// Test-only routes, mounted under /v1/_test, to exercise validation and error handling.
@Controller("_test")
class TestController {
  @Post("echo")
  echo(@Body(new ZodPipe(echoBody)) body: z.output<typeof echoBody>) {
    return body;
  }

  @Get("boom")
  boom(): never {
    throw new Error("database password is hunter2");
  }
}

@Module({ controllers: [TestController] })
export class TestModule {}
