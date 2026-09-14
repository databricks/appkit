import { randomUUID } from "node:crypto";

import type { AgentAdapter, Message } from "shared";
import type { z } from "zod";

import { StructuredOutputError } from "../../errors";
import { consumeAdapterStream } from "./consume-adapter-stream";
import { formatZodIssues } from "./tools/tool";

/** Re-prompted structuring passes after the first convert pass (so ≤3 total). Separate from the tool-call / maxSteps budget. */
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
 * Runs one tool-free, schema-constrained completion and returns the raw text.
 * Injected so the resolver stays free of any adapter / MLflow dependency; see
 * {@link buildStructuringPass}.
 */
export type StructuringPass = (
  messages: Message[],
  signal?: AbortSignal,
) => Promise<string>;

interface ResolveStructuredOutputParams<T> {
  /** Schema the final object is validated against. */
  schema: z.ZodType<T>;
  /** The conversation the main run saw (system + thread), without the final answer. */
  baseMessages: Message[];
  /** The main run's final assistant text — the answer to reformat into JSON. */
  finalText: string;
  /** Runs one tool-free, schema-constrained completion (see {@link StructuringPass}). */
  runStructuringPass: StructuringPass;
  signal?: AbortSignal;
}

/**
 * Turns an agent's answer into a schema-validated object. Validates `finalText`
 * as-is first (skipping a structuring round-trip when the model already emitted
 * valid JSON); otherwise re-prompts a tool-free structuring pass with the
 * flattened Zod issues, up to {@link MAX_VALIDATION_RETRIES} times. Throws
 * {@link StructuredOutputError} on exhaustion — never returns partial data.
 */
export async function resolveStructuredOutput<T>(
  params: ResolveStructuredOutputParams<T>,
): Promise<T> {
  const { schema, baseMessages, finalText, runStructuringPass, signal } =
    params;

  const direct = parseAndValidate(schema, finalText);
  if (direct.ok) return direct.value;

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
  return { ok: false, error: formatZodIssues(result.error) };
}

/** Strip a leading/trailing Markdown code fence — models often wrap JSON in ` ```json … ``` `. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

/**
 * Builds a {@link StructuringPass}: one tool-free, schema-constrained
 * `adapter.run()` consumed to its text. `executeTool` throws — a tool-free
 * pass must never dispatch one.
 */
export function buildStructuringPass(
  adapter: AgentAdapter,
  outputSchema: Record<string, unknown>,
): StructuringPass {
  return (messages, signal) =>
    consumeAdapterStream(
      adapter.run(
        { messages, tools: [], threadId: randomUUID(), signal, outputSchema },
        {
          executeTool: () => {
            throw new Error(
              "structured-output structuring pass is tool-free and must not call a tool",
            );
          },
          signal,
        },
      ),
      { signal },
    );
}
