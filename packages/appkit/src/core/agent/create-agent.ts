import type { z } from "zod";

import { ConfigurationError } from "../../errors";
import type { AgentDefinition } from "./types";

/**
 * Non-enumerable brand stamped on every {@link createAgent} result. The
 * code-agent loader ({@link loadCodeAgentsFromDir}) uses it to tell a real
 * agent export from any other value a module in `server/agents/` might
 * export, without duck-typing or guessing from the filename.
 *
 * A registered (`Symbol.for`) symbol so the check still holds if two copies
 * of the package end up loaded in one process — the app's agent files and
 * the plugin can resolve `@databricks/appkit` independently.
 */
const AGENT_BRAND: unique symbol = Symbol.for("appkit.agent");

/**
 * Pure factory for agent definitions: cycle-detects the sub-agent graph and
 * returns the same object, stamped with a non-enumerable {@link AGENT_BRAND}
 * so discovery recognizes it. Safe at module top-level; no adapter is built.
 * Don't `Object.freeze` the definition before passing it in — the brand is
 * written onto the argument.
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
 *
 * @example Structured output
 * ```ts
 * const classify = createAgent({
 *   instructions: "Classify the ticket.",
 *   output: z.object({ category: z.string(), urgent: z.boolean() }),
 * });
 * // In-process, the result is typed via z.infer:
 * const { output } = await runAgent(classify, { messages: "..." });
 * output?.category; // string | undefined
 * ```
 */
export function createAgent<S extends z.ZodType>(
  def: AgentDefinition<z.infer<S>> & { output: S },
): AgentDefinition<z.infer<S>>;
export function createAgent(def: AgentDefinition): AgentDefinition;
export function createAgent(
  def: AgentDefinition<unknown>,
): AgentDefinition<unknown> {
  detectCycles(def);
  // Non-enumerable + in-place: identity, JSON, and spread are unaffected.
  Object.defineProperty(def, AGENT_BRAND, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return def;
}

/**
 * Type guard: true when `value` was produced by {@link createAgent}. Used by
 * the code-agent loader to pick the agent export out of a discovered module.
 */
export function isCreatedAgent(value: unknown): value is AgentDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[AGENT_BRAND] === true
  );
}

/**
 * Walks the `agents: { ... }` sub-agent tree via DFS and throws if a cycle is
 * found. Cycles would cause infinite recursion at tool-invocation time.
 */
function detectCycles(def: AgentDefinition<unknown>): void {
  const visiting = new Set<AgentDefinition<unknown>>();
  const visited = new Set<AgentDefinition<unknown>>();

  const walk = (current: AgentDefinition<unknown>, path: string[]): void => {
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
