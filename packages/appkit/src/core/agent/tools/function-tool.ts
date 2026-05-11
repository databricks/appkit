import type { AgentToolDefinition, ToolAnnotations } from "shared";

export interface FunctionTool {
  type: "function";
  name: string;
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
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export function isFunctionTool(value: unknown): value is FunctionTool {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.type === "function" &&
    typeof obj.name === "string" &&
    typeof obj.execute === "function"
  );
}

export function functionToolToDefinition(
  tool: FunctionTool,
): AgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: (tool.parameters as AgentToolDefinition["parameters"]) ?? {
      type: "object",
      properties: {},
    },
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}
