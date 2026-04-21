import type { ToolProvider } from "shared";
import type { ToolkitEntry, ToolkitOptions } from "./types";

/**
 * Internal interface: a `ToolProvider` that optionally exposes a typed
 * `.toolkit(opts)` method. Core plugins (analytics, files, genie, lakebase)
 * implement this; third-party `ToolProvider`s may not.
 */
type MaybeToolkitProvider = ToolProvider & {
  toolkit?: (opts?: ToolkitOptions) => Record<string, ToolkitEntry>;
};

/**
 * Resolve a plugin's tools into a keyed record of {@link ToolkitEntry} markers
 * ready to be merged into an agent's tool index.
 *
 * Preferred path: call the plugin's own `.toolkit(opts)` method, which
 * typically delegates to `buildToolkitEntries` with full `ToolkitOptions`
 * support (prefix, only, except, rename).
 *
 * Fallback path: when the plugin doesn't expose `.toolkit()` (e.g. a
 * third-party `ToolProvider` built with plain `toPlugin`), walk
 * `getAgentTools()` and synthesize namespaced keys (`${pluginName}.${name}`)
 * while still honoring `only` / `except` / `rename` / `prefix`.
 *
 * This helper is the single source of truth for "turn a provider into a
 * toolkit entry record" and is used by `AgentsPlugin.buildToolIndex`
 * (both the `fromPlugin` resolution pass and auto-inherit) and by the
 * standalone `runAgent` executor.
 */
export function resolveToolkitFromProvider(
  pluginName: string,
  provider: ToolProvider,
  opts?: ToolkitOptions,
): Record<string, ToolkitEntry> {
  const withToolkit = provider as MaybeToolkitProvider;
  if (typeof withToolkit.toolkit === "function") {
    return withToolkit.toolkit(opts);
  }

  const only = opts?.only ? new Set(opts.only) : null;
  const except = opts?.except ? new Set(opts.except) : null;
  const rename = opts?.rename ?? {};
  const prefix = opts?.prefix ?? `${pluginName}.`;

  const out: Record<string, ToolkitEntry> = {};
  for (const tool of provider.getAgentTools()) {
    if (only && !only.has(tool.name)) continue;
    if (except?.has(tool.name)) continue;

    const keyAfterPrefix = `${prefix}${tool.name}`;
    const key = rename[tool.name] ?? keyAfterPrefix;

    out[key] = {
      __toolkitRef: true,
      pluginName,
      localName: tool.name,
      def: { ...tool, name: key },
    };
  }
  return out;
}
