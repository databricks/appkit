import { toJSONSchema, type z } from "zod";

/**
 * Converts a Zod schema to JSON Schema suitable for an LLM tool-call
 * `parameters` field.
 *
 * Wraps `zod`'s `toJSONSchema()` and strips the top-level `$schema` annotation
 * that Zod v4 emits by default (e.g. `"https://json-schema.org/draft/..."`).
 * The Databricks Mosaic serving endpoint forwards tool schemas to Google's
 * Gemini `function_declarations` format, which rejects any top-level key it
 * doesn't explicitly recognize — including `$schema` — with a 400
 * `Invalid JSON payload received. Unknown name "$schema"` error. Other LLM
 * providers either ignore the field or also trip on it, so stripping here is
 * safe across backends.
 */
export function toToolJSONSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return rest;
}
