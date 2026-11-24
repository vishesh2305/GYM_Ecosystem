import { z } from "zod";
import { problemSchema } from "./problem";
import type { Route } from "./route";

type JsonSchema = Record<string, unknown>;

interface Parameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: JsonSchema;
}

interface Operation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters: Parameter[];
  requestBody?: { required: true; content: { "application/json": { schema: JsonSchema } } };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, Partial<Record<Lowercase<Route["method"]>, Operation>>>;
  components: { schemas: Record<string, JsonSchema> };
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" });
  return rest;
}

function parameters(shape: z.ZodObject | undefined, where: Parameter["in"]): Parameter[] {
  if (!shape) return [];
  return Object.entries(shape.shape).map(([name, schema]) => ({
    name,
    in: where,
    required: where === "path" || !schema.safeParse(undefined).success,
    schema: jsonSchema(schema, "input"),
  }));
}

/** Build an OpenAPI 3.1 document from named routes; the key becomes the operationId. */
export function buildOpenApi(
  routes: Record<string, Route>,
  info: OpenApiDocument["info"],
): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const [operationId, route] of Object.entries(routes)) {
    const method = route.method.toLowerCase() as Lowercase<Route["method"]>;
    const item = (paths[route.path] ??= {});
    if (item[method]) throw new Error(`Duplicate route ${route.method} ${route.path}`);
    item[method] = {
      operationId,
      summary: route.summary,
      tags: [route.tag],
      parameters: [...parameters(route.params, "path"), ...parameters(route.query, "query")],
      ...(route.body && {
        requestBody: {
          required: true,
          content: { "application/json": { schema: jsonSchema(route.body, "input") } },
        },
      }),
      responses: {
        [String(route.status ?? 200)]: {
          description: "Success",
          content: { "application/json": { schema: jsonSchema(route.response, "output") } },
        },
        default: {
          description: "Problem details (RFC 9457)",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info,
    paths,
    components: { schemas: { Problem: jsonSchema(problemSchema, "output") } },
  };
}
