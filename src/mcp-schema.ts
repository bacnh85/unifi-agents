// Adapter: canonical JSON Schema (tools.ts) → ZodRawShape (what the MCP SDK v1
// registerTool expects). Only the types tools.ts emits are handled; anything
// else falls back to z.any() so a schema change can never kill the server.
import { z, type ZodType } from "zod";
import type { JsonSchema, JsonSchemaProperty } from "./tools.js";

export function jsonSchemaToRawShape(
  schema: JsonSchema,
): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    shape[name] = wrap(prop, required.has(name));
  }
  return shape;
}

function wrap(prop: JsonSchemaProperty, isRequired: boolean): ZodType {
  let base: ZodType;
  if (prop.enum && prop.enum.length > 0) {
    base = z.enum(prop.enum as [string, ...string[]]);
  } else {
    switch (prop.type) {
      case "string":
        base = z.string();
        break;
      case "integer":
        base = z.number().int();
        break;
      case "number":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array":
        base = z.array(z.any());
        break;
      case "object":
        base = prop.properties
          ? z.object(jsonSchemaToRawShape({ type: "object", properties: prop.properties, required: prop.required }))
          : z.record(z.string(), z.any());
        break;
      default:
        base = z.any();
    }
  }
  if (!isRequired) base = base.optional();
  if (prop.default !== undefined) base = base.default(prop.default);
  return prop.description ? base.describe(prop.description) : base;
}
