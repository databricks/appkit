import { z } from "zod";

import { AiFunctionsRequestError } from "./errors";
import type {
  AiFunctionName,
  ClassifyRequest,
  DecideRequest,
  ExtractRequest,
  StructuredInput,
  StructuredObject,
} from "./types";

const MAX_INSTRUCTIONS_CHARS = 20_000;

const opaqueObjectSchema = z.object({}).passthrough();
const instructionsSchema = z
  .string()
  .refine(
    (instructions) => Array.from(instructions).length <= MAX_INSTRUCTIONS_CHARS,
    `instructions must not exceed ${MAX_INSTRUCTIONS_CHARS} code points`,
  );
const structuredInputSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  opaqueObjectSchema,
]);

const classifyOptionsSchema = z
  .object({
    version: z.literal("2.1").optional(),
    instructions: instructionsSchema.optional(),
    multilabel: z.boolean().optional(),
    enable_confidence_scores: z.boolean().optional(),
    enable_rationales: z.boolean().optional(),
  })
  .strict();

const extractOptionsSchema = z
  .object({
    version: z.literal("2.1").optional(),
    instructions: instructionsSchema.optional(),
    mode: z.literal("precision").optional(),
    enable_citations: z.boolean().optional(),
    enable_confidence_scores: z.boolean().optional(),
  })
  .strict();

const decideOptionsSchema = z
  .object({ version: z.literal("1.0").optional() })
  .strict();

const labelsArraySchema = z.array(z.string().min(1).max(100)).min(2).max(500);
const labelsRecordSchema = z
  .record(z.string().min(1).max(100), z.string())
  .refine(
    (labels) =>
      Object.keys(labels).length >= 2 && Object.keys(labels).length <= 500,
    "labels must contain between 2 and 500 entries",
  );

const contentSchema = z.union([
  z
    .string()
    .refine(
      (content) => content.trim().length > 0,
      "content must not be empty",
    ),
  opaqueObjectSchema,
]);

const classifyRequestSchema = z
  .object({
    content: contentSchema,
    labels: z.union([labelsArraySchema, labelsRecordSchema]),
    options: classifyOptionsSchema.optional(),
  })
  .strict();

const extractSchema = z.union([
  z.array(z.string()).max(256),
  z
    .record(z.string(), z.unknown())
    .refine(
      (schema) => Object.keys(schema).length <= 256,
      "schema must contain at most 256 entries",
    ),
]);

const extractRequestSchema = z
  .object({
    content: contentSchema,
    schema: extractSchema,
    options: extractOptionsSchema.optional(),
  })
  .strict();

const choiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: structuredInputSchema,
    criteria: z
      .record(z.string().min(1), z.union([structuredInputSchema, z.null()]))
      .refine((criteria) => {
        const count = Object.keys(criteria).length;
        return count >= 1 && count <= 255;
      }, "criteria must contain between 1 and 255 entries"),
  })
  .strict();

const noulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: structuredInputSchema,
    criteria: z
      .object({
        true: structuredInputSchema.optional(),
        false: structuredInputSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const scoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: structuredInputSchema,
    criteria: z.array(structuredInputSchema).min(2).max(10),
  })
  .strict();

const decideQuestionSchema = z.discriminatedUnion("type", [
  choiceQuestionSchema,
  noulQuestionSchema,
  scoreQuestionSchema,
]);

const decideRequestSchema = z
  .object({
    state: structuredInputSchema,
    questions: z
      .record(z.string().min(1), decideQuestionSchema)
      .refine(
        (questions) => Object.keys(questions).length > 0,
        "questions must contain at least one entry",
      ),
    options: decideOptionsSchema.optional(),
  })
  .strict();

function describeIssue(issue: {
  code: string;
  keys?: string[];
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  values?: unknown[];
}): string | undefined {
  const unitFor = (count: number | bigint) => {
    const one = Number(count) === 1;
    if (issue.origin === "string") return one ? "character" : "characters";
    if (issue.origin === "array") return one ? "item" : "items";
    return undefined;
  };
  switch (issue.code) {
    case "unrecognized_keys": {
      if (!issue.keys?.length) return undefined;
      const keys = issue.keys.map((key) => `"${key}"`).join(", ");
      const camel = issue.keys.find((key) => /[a-z][A-Z]/.test(key));
      const hint = camel
        ? `; use snake_case, such as "${camel.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}"`
        : "";
      return `has unknown ${issue.keys.length === 1 ? "key" : "keys"} ${keys}${hint}`;
    }
    case "too_small":
      return issue.minimum !== undefined && unitFor(issue.minimum)
        ? `must have at least ${issue.minimum} ${unitFor(issue.minimum)}`
        : undefined;
    case "too_big":
      return issue.maximum !== undefined && unitFor(issue.maximum)
        ? `must have at most ${issue.maximum} ${unitFor(issue.maximum)}`
        : undefined;
    case "invalid_value":
      return issue.values?.length
        ? `must be ${issue.values.map((value) => JSON.stringify(value)).join(" or ")}`
        : undefined;
    default:
      return undefined;
  }
}

function formatAiFunctionsValidationMessage(issue: {
  code: string;
  path: PropertyKey[];
  message?: string;
}): string {
  const keyContainers = new Set(["labels", "questions", "criteria", "schema"]);
  const path = issue.path
    .map((segment, index, segments) => {
      const parent = segments[index - 1];
      return typeof parent === "string" && keyContainers.has(parent)
        ? "<key>"
        : String(segment);
    })
    .join(".");

  if (issue.code === "custom" && issue.message) {
    return issue.message;
  }

  // Name unknown keys only at the request root and in `options`, where they
  // are API field names. Elsewhere (such as questions) keys stay unnamed.
  const namesKeys =
    issue.path.length === 0 ||
    (issue.path.length === 1 && issue.path[0] === "options");
  const detail = describeIssue(
    issue.code === "unrecognized_keys" && !namesKeys
      ? { code: issue.code }
      : issue,
  );
  if (!detail) return path ? `${issue.code}: ${path}` : issue.code;
  return `${issue.code}: ${path || "request"} ${detail}`;
}

function resolveVersion(request: unknown, version: "2.1" | "1.0"): unknown {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    return request;
  }

  const requestObject = request as Record<string, unknown>;
  const options = requestObject.options;
  const resolvedOptions =
    typeof options === "object" && options !== null && !Array.isArray(options)
      ? (options as { version?: unknown }).version !== undefined
        ? options
        : { ...options, version }
      : options === undefined
        ? { version }
        : options;

  return { ...requestObject, options: resolvedOptions };
}

export function parseClassifyRequest(request: unknown): ClassifyRequest {
  const parsed = classifyRequestSchema.safeParse(
    resolveVersion(request, "2.1"),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AiFunctionsRequestError(
      formatAiFunctionsValidationMessage(issue),
      { statusCode: 400, functionName: "classify" },
    );
  }
  return parsed.data;
}

export function parseExtractRequest(request: unknown): ExtractRequest {
  const parsed = extractRequestSchema.safeParse(resolveVersion(request, "2.1"));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AiFunctionsRequestError(
      formatAiFunctionsValidationMessage(issue),
      { statusCode: 400, functionName: "extract" },
    );
  }
  return parsed.data;
}

export function parseDecideRequest(request: unknown): DecideRequest {
  const parsed = decideRequestSchema.safeParse(resolveVersion(request, "1.0"));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AiFunctionsRequestError(
      formatAiFunctionsValidationMessage(issue),
      { statusCode: 400, functionName: "decide" },
    );
  }
  return parsed.data;
}

const contentInputSchema = z.object({ content: contentSchema }).strict();
const stateInputSchema = z.object({ state: structuredInputSchema }).strict();

/**
 * Parses a task route body or tool input: exactly `{ content }` for classify
 * and extract, `{ state }` for decide.
 */
export function parseTaskInput(
  functionName: AiFunctionName,
  input: unknown,
): { content: string | StructuredObject } | { state: StructuredInput } {
  const schema =
    functionName === "decide" ? stateInputSchema : contentInputSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // zod reports a missing field before unknown keys. Report the unknown key
    // first: it tells a client it can't override a task's fields.
    const issue =
      parsed.error.issues.find((i) => i.code === "unrecognized_keys") ??
      parsed.error.issues[0];
    throw new AiFunctionsRequestError(
      formatAiFunctionsValidationMessage(issue),
      { statusCode: 400, functionName },
    );
  }
  return parsed.data as
    | { content: string | StructuredObject }
    | { state: StructuredInput };
}
