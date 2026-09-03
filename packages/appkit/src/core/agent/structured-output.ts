import { randomUUID } from "node:crypto";

import type { Message } from "shared";
import type { z } from "zod";

import { StructuredOutputError } from "../../errors";

/**
 * Max number of re-prompted structuring passes after the first validation
 * fails. So ≤3 total validation attempts, and ≤3 structuring passes for a
 * tool-having agent (1 initial + 2 retries) / ≤2 for a tool-free one (the
 * first attempt is the inline `response_format` output, retries add passes).
 * Tracked here, separate from the tool-call / maxSteps budget.
 */
const MAX_VALIDATION_RETRIES = 2;

const CONVERT_INSTRUCTION =
  "Convert the assistant's answer above into JSON matching the provided schema. " +
  "Output only the JSON, with no prose, explanation, or code fences.";

function retryInstruction(errors: string): string {
  return (
    "Your previous response did not match the required schema. " +
    `Validation errors: ${errors}. ` +
    "Return only JSON matching the schema, with no prose or code fences."
  );
}

/**
 * Runs ONE tool-free, schema-constrained completion over `messages` and
 * returns the raw model text. Injected by the caller so the resolver stays
 * free of any adapter / MLflow dependency: the agents plugin and standalone
 * `runAgent` each build this from `adapter.run({ tools: [], outputSchema })`.
 */
export type StructuringPass = (
  messages: Message[],
  signal?: AbortSignal,
) => Promise<string>;

interface ResolveStructuredOutputParams<T> {
  /** Schema the final object is validated against. */
  schema: z.ZodType<T>;
  /**
   * The conversation the main run saw (system + thread messages), WITHOUT the
   * final answer. Each structuring pass appends the latest answer + an
   * instruction to this.
   */
  baseMessages: Message[];
  /** The main run's final assistant text (the answer to reformat into JSON). */
  finalText: string;
  /** Runs one tool-free, schema-constrained completion (see {@link StructuringPass}). */
  runStructuringPass: StructuringPass;
  signal?: AbortSignal;
}

/**
 * Validate-and-retry loop that turns an agent's answer into a typed object.
 *
 * The agent's visible answer (`finalText`) is validated as-is first — a model
 * may already emit valid JSON — as a cheap pre-check. Otherwise a tool-free,
 * schema-constrained structuring pass reformats it into JSON, re-prompting with
 * the flattened Zod issues on each failure (up to {@link MAX_VALIDATION_RETRIES}
 * times). On exhaustion it throws {@link StructuredOutputError} carrying the
 * last raw output; it never returns partial/unvalidated data.
 */
export async function resolveStructuredOutput<T>(
  params: ResolveStructuredOutputParams<T>,
): Promise<T> {
  const { schema, baseMessages, finalText, runStructuringPass, signal } =
    params;

  // Cheap pre-check: the answer may already be valid JSON (no round-trip).
  const direct = parseAndValidate(schema, finalText);
  if (direct.ok) return direct.value;

  // Reformat the answer into JSON via a tool-free structuring pass.
  let lastRaw = await runStructuringPass(
    structuringMessages(baseMessages, finalText, CONVERT_INSTRUCTION),
    signal,
  );

  for (let retries = 0; ; retries++) {
    const parsed = parseAndValidate(schema, lastRaw);
    if (parsed.ok) return parsed.value;

    if (retries >= MAX_VALIDATION_RETRIES) {
      throw new StructuredOutputError(
        `Agent output did not match the required schema after ` +
          `${MAX_VALIDATION_RETRIES + 1} attempts: ${parsed.error}`,
        { lastRaw },
      );
    }

    lastRaw = await runStructuringPass(
      structuringMessages(
        baseMessages,
        lastRaw,
        retryInstruction(parsed.error),
      ),
      signal,
    );
  }
}

/** Appends the latest answer (as an assistant turn) + a user instruction. */
function structuringMessages(
  base: Message[],
  assistantText: string,
  instruction: string,
): Message[] {
  return [
    ...base,
    {
      id: randomUUID(),
      role: "assistant",
      content: assistantText,
      createdAt: new Date(),
    },
    {
      id: randomUUID(),
      role: "user",
      content: instruction,
      createdAt: new Date(),
    },
  ];
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseAndValidate<T>(
  schema: z.ZodType<T>,
  raw: string,
): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFences(raw));
  } catch {
    return { ok: false, error: "response was not valid JSON" };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: flattenZodError(result.error) };
}

/**
 * Strip a single leading/trailing Markdown code fence. `response_format`
 * output is bare JSON, but on the 400-strip fallback (or a model that ignores
 * the param) the answer often arrives fenced (` ```json … ``` `). Cheap to
 * undo and materially raises the parse rate on that path.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

/** Compact one-line rendering of a ZodError's issues, safe across zod v4. */
function flattenZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
