import type { ToolAnnotations } from "shared";
import type { z } from "zod";
import type { FunctionTool } from "./function-tool";
import { toToolJSONSchema } from "./json-schema";

export interface ToolConfig<S extends z.ZodType> {
  /**
   * Optional. When the tool is placed in a keyed record (the standard
   * `tools: { my_tool: tool({...}) }` form, or the function form
   * `tools(plugins) => ({ my_tool: tool({...}) })`), the agents plugin
   * overrides the tool's LLM-visible name with the record key. Set
   * `name` explicitly only if you're constructing a `FunctionTool`
   * outside any keyed-record context — otherwise the record key wins.
   */
  name?: string;
  /**
   * What the tool does, what it expects, and when the LLM should call it.
   * The model reads this verbatim when deciding whether to invoke the tool,
   * so write it for an LLM, not for a human reader of your code: spell out
   * the inputs, the return shape, and any pre-conditions or side effects.
   *
   * Required. Earlier versions silently fell back to the tool's name when
   * omitted, which surfaced cryptic identifiers like `"get_weather"` as the
   * description — the model then had no signal about expected use and
   * either skipped the tool or called it speculatively. Making this
   * mandatory at the type level forces a real description at authoring
   * time instead of debugging a confused agent later.
   */
  description: string;
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
  /**
   * Returning a non-string value is fine: the agent runtime serializes
   * the result via `normalizeToolResult` before handing it to the LLM
   * (strings pass through; `null` becomes `"null"`; everything else gets
   * `JSON.stringify`'d; `undefined` becomes `""`). Return whatever shape
   * is most natural for your tool — typically an object — and let the
   * runtime handle the wire format.
   */
  execute: (args: z.infer<S>) => unknown | Promise<unknown>;
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
  const parameters = toToolJSONSchema(config.schema);

  // `name` is only used for the zod-validation error message and the
  // FunctionTool's `name` field; the agents plugin overrides the latter
  // with the record key (`tools: { my_tool: ... }` -> "my_tool") at
  // index-build time. Fall back to a generic label so errors are still
  // legible when `name` is omitted.
  const labelForErrors = config.name ?? "tool";

  return {
    type: "function",
    ...(config.name !== undefined ? { name: config.name } : {}),
    description: config.description,
    parameters,
    ...(config.annotations ? { annotations: config.annotations } : {}),
    execute: async (args: Record<string, unknown>) => {
      const parsed = config.schema.safeParse(args);
      if (!parsed.success) {
        return formatZodError(parsed.error, labelForErrors);
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
