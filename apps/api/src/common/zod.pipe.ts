import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ValidationProblem } from "./problem";

/** Validate a request part with a contract schema: `@Body(new ZodPipe(route.body))`. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new ValidationProblem(
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
}
