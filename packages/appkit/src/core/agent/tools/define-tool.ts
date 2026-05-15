import type { AgentToolDefinition, ToolAnnotations } from "shared";
import type { z } from "zod";
import { toToolJSONSchema } from "./json-schema";
import { formatZodError } from "./tool";

/**
 * Single-tool entry for a plugin's internal tool registry.
 *
 * Plugins collect these into a `Record<string, ToolEntry>` keyed by the tool's
 * public name and dispatch via `executeFromRegistry`.
 */
export interface ToolEntry<S extends z.ZodType = z.ZodType> {
  description: string;
  schema: S;
  annotations?: ToolAnnotations;
  /**
   * Whether this tool is eligible for auto-inheritance into markdown or
   * code-defined agents that enable `autoInheritTools`. Defaults to `false`
   * (safe-by-default) — plugin authors must explicitly opt a tool in if they
   * consider it safe enough to appear in every agent's tool record without an
   * explicit `tools:` declaration. Destructive or privilege-sensitive tools
   * should leave this unset so that they only reach agents that wire them
   * explicitly (via `tools:` object/function form, markdown `plugin:NAME`
   * entries in the unified `tools:` list, or
   * `plugins.<name>.toolkit({ only: [...] })`).
   */
  autoInheritable?: boolean;
  /**
   * Callback the agents plugin invokes after Zod validation succeeds.
   *
   * Named `execute` to match the public `tool({ execute })` form — both the
   * agent-author surface and the plugin-author surface now spell their
   * callback the same way. `args` is the inferred Zod output (so `T extends
   * z.ZodType` flows through and `args` is fully typed). `signal` is the
   * per-run AbortSignal: forward it to any awaited I/O so cancellation
   * actually unwinds the call (analytics and lakebase both do this).
   */
  execute: (
    args: z.infer<S>,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolEntry>;

/**
 * Defines a single tool entry for a plugin's internal registry.
 *
 * The generic `S` flows from `schema` through to the `handler` callback so
 * `args` is fully typed from the Zod schema. Names are assigned by the
 * registry key, so they are not repeated inside the entry.
 */
export function defineTool<S extends z.ZodType>(
  config: ToolEntry<S>,
): ToolEntry<S> {
  return config;
}

/**
 * Validates tool-call arguments against the entry's schema and invokes its
 * handler. On validation failure, returns an LLM-friendly error string
 * (matching the behavior of `tool()`) rather than throwing, so the model
 * can self-correct on its next turn.
 */
export async function executeFromRegistry(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const entry = registry[name];
  if (!entry) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const parsed = entry.schema.safeParse(args);
  if (!parsed.success) {
    return formatZodError(parsed.error, name);
  }
  return entry.execute(parsed.data, signal);
}

/**
 * Produces the `AgentToolDefinition[]` a ToolProvider exposes to the LLM,
 * deriving `parameters` JSON Schema from each entry's Zod schema.
 *
 * Tool names come from registry keys (supports dotted names like
 * `uploads.list` for dynamic plugins).
 */
export function toolsFromRegistry(
  registry: ToolRegistry,
): AgentToolDefinition[] {
  return Object.entries(registry).map(([name, entry]) => {
    const parameters = toToolJSONSchema(
      entry.schema,
    ) as unknown as AgentToolDefinition["parameters"];
    const def: AgentToolDefinition = {
      name,
      description: entry.description,
      parameters,
    };
    if (entry.annotations) {
      def.annotations = entry.annotations;
    }
    return def;
  });
}
