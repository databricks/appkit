import { ConfigurationError } from "../../errors";
import type { AgentDefinition } from "./types";

/**
 * Pure factory for agent definitions. Returns the passed-in definition after
 * cycle-detecting the sub-agent graph. Accepts the full `AgentDefinition` shape
 * and is safe to call at module top-level.
 *
 * The returned value is a plain `AgentDefinition` — no adapter construction,
 * no side effects. Register it with `agents({ agents: { name: def } })` or run
 * it standalone via `runAgent(def, input)`.
 *
 * @example
 * ```ts
 * const support = createAgent({
 *   instructions: "You help customers.",
 *   model: "databricks-claude-sonnet-4-5",
 *   tools: {
 *     get_weather: tool({ ... }),
 *   },
 * });
 * ```
 */
export function createAgent(def: AgentDefinition): AgentDefinition {
  detectCycles(def);
  return def;
}

/**
 * Walks the `agents: { ... }` sub-agent tree via DFS and throws if a cycle is
 * found. Cycles would cause infinite recursion at tool-invocation time.
 */
function detectCycles(def: AgentDefinition): void {
  const visiting = new Set<AgentDefinition>();
  const visited = new Set<AgentDefinition>();

  const walk = (current: AgentDefinition, path: string[]): void => {
    if (visited.has(current)) return;
    if (visiting.has(current)) {
      throw new ConfigurationError(
        `Agent sub-agent cycle detected: ${path.join(" -> ")}`,
      );
    }
    visiting.add(current);
    for (const [childKey, child] of Object.entries(current.agents ?? {})) {
      walk(child, [...path, childKey]);
    }
    visiting.delete(current);
    visited.add(current);
  };

  walk(def, [def.name ?? "(root)"]);
}
