import type { ToolAnnotations } from "shared";
import type { z } from "zod";
import type { FunctionTool } from "./function-tool";
import { toToolJSONSchema } from "./json-schema";

export interface ToolConfig<S extends z.ZodType> {
  name: string;
  description?: string;
  schema: S;
  /**
   * Behavioural hints forwarded to the resolved tool definition. Prefer
   * `effect` (`"read" | "write" | "update" | "destructive"`) — any mutating
   * value forces the agents-plugin approval gate before `execute()` runs
   * and the client's approval card will colour itself accordingly. Legacy
   * `destructive: true` still gates. Dropped silently before the fix that
   * added this field.
   */
  annotations?: ToolAnnotations;
  execute: (args: z.infer<S>) => Promise<string> | string;
}

/**
 * Factory for defining function tools with Zod schemas.
 *
 * - Generates JSON Schema (for the LLM) from the Zod schema via `z.toJSONSchema()`.
 * - Infers the `execute` argument type from the schema.
 * - Validates tool call arguments at runtime. On validation failure, returns
 *   a formatted error string to the LLM instead of throwing, so the model
 *   can self-correct on its next turn.
 */
export function tool<S extends z.ZodType>(config: ToolConfig<S>): FunctionTool {
  const parameters = toToolJSONSchema(config.schema) as unknown as Record<
    string,
    unknown
  >;

  return {
    type: "function",
    name: config.name,
    description: config.description ?? config.name,
    parameters,
    ...(config.annotations ? { annotations: config.annotations } : {}),
    execute: async (args: Record<string, unknown>) => {
      const parsed = config.schema.safeParse(args);
      if (!parsed.success) {
        return formatZodError(parsed.error, config.name);
      }
      return config.execute(parsed.data as z.infer<S>);
    },
  };
}

/**
 * Formats a Zod validation error into an LLM-friendly string.
 *
 * Example: `Invalid arguments for get_weather: city: Invalid input: expected string, received undefined`
 */
export function formatZodError(error: z.ZodError, toolName: string): string {
  const parts = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${field}: ${issue.message}`;
  });
  return `Invalid arguments for ${toolName}: ${parts.join("; ")}`;
}
