import type { AgentToolDefinition } from "shared";
import type { ToolRegistry } from "./tools/define-tool";
import { toToolJSONSchema } from "./tools/json-schema";
import type { ToolkitEntry, ToolkitOptions } from "./types";

/**
 * Converts a plugin's internal `ToolRegistry` into a keyed record of
 * `ToolkitEntry` markers suitable for spreading into an `AgentDefinition.tools`
 * record.
 *
 * The `opts` record controls shape and filtering:
 * - `prefix` — overrides the default `${pluginName}.` prefix; `""` drops it.
 * - `only` — allowlist of local tool names to include (post-prefix).
 * - `except` — denylist of local names.
 * - `rename` — per-tool key remapping (applied after prefix/filter).
 *
 * Each entry carries `pluginName` + `localName` so the agents plugin can
 * dispatch back through `PluginContext.executeTool` for OBO + telemetry.
 */
export function buildToolkitEntries(
  pluginName: string,
  registry: ToolRegistry,
  opts: ToolkitOptions = {},
): Record<string, ToolkitEntry> {
  const prefix = opts.prefix ?? `${pluginName}.`;
  const only = opts.only ? new Set(opts.only) : null;
  const except = opts.except ? new Set(opts.except) : null;
  const rename = opts.rename ?? {};

  const out: Record<string, ToolkitEntry> = {};

  for (const [localName, entry] of Object.entries(registry)) {
    if (only && !only.has(localName)) continue;
    if (except?.has(localName)) continue;

    const keyAfterPrefix = `${prefix}${localName}`;
    const key = rename[localName] ?? keyAfterPrefix;

    const parameters = toToolJSONSchema(
      entry.schema,
    ) as unknown as AgentToolDefinition["parameters"];

    const def: AgentToolDefinition = {
      name: key,
      description: entry.description,
      parameters,
    };
    if (entry.annotations) {
      def.annotations = entry.annotations;
    }

    out[key] = {
      __toolkitRef: true,
      pluginName,
      localName,
      def,
      annotations: entry.annotations,
      autoInheritable: entry.autoInheritable,
    };
  }

  return out;
}
