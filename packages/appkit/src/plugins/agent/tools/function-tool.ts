import type { AgentToolDefinition } from "shared";

export interface FunctionTool {
  type: "function";
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
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
  };
}
