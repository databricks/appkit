import type { AgentToolDefinition, ToolAnnotations } from "shared";

export interface FunctionTool {
  type: "function";
  /**
   * Optional. When this tool is placed in a keyed record
   * (`tools: { my_tool: ... }` or the function form), the agents plugin
   * overrides this with the record key at index-build time. Only set it
   * explicitly when constructing a `FunctionTool` outside any
   * keyed-record context.
   */
  name?: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
  /**
   * Behavioural hints that drive the agents plugin's approval gate and the
   * client's approval-card styling. Prefer setting `effect` (one of
   * `"read" | "write" | "update" | "destructive"`) — any mutating value
   * forces HITL approval before `execute()` runs. Legacy `destructive: true`
   * is still honoured. Must be preserved through {@link
   * functionToolToDefinition} so the plugin sees them when building agent
   * tool indexes.
   */
  annotations?: ToolAnnotations;
  /**
   * Returns any shape; downstream `normalizeToolResult` serializes to a
   * string before handing the value to the LLM.
   */
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export function isFunctionTool(value: unknown): value is FunctionTool {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  // `name` is intentionally not required: the agents plugin overrides it
  // with the record key (`tools: { my_tool: tool({...}) }` -> "my_tool")
  // so requiring it on the FunctionTool shape rejects perfectly-valid
  // `tool({ description, schema, execute })` calls that omit the name.
  return obj.type === "function" && typeof obj.execute === "function";
}

export function functionToolToDefinition(
  tool: FunctionTool,
): AgentToolDefinition {
  // `name` is guaranteed to be overridden downstream by the record key
  // when the tool is registered through `AgentDefinition.tools`. Falling
  // back to an empty string here keeps the type honest without
  // surfacing a sentinel that could leak into a non-record context.
  const name = tool.name ?? "";
  return {
    name,
    description: tool.description ?? name,
    parameters: (tool.parameters as AgentToolDefinition["parameters"]) ?? {
      type: "object",
      properties: {},
    },
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}
