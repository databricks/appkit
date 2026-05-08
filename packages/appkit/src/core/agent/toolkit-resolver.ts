import type { ToolProvider } from "shared";
import { applyToolkitOptions } from "./toolkit-options";
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
 * (the `tools(plugins)` resolution pass and auto-inherit) and by the
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

  const out: Record<string, ToolkitEntry> = {};
  for (const tool of provider.getAgentTools()) {
    const key = applyToolkitOptions(tool.name, pluginName, opts);
    if (key === null) continue;

    out[key] = {
      __toolkitRef: true,
      pluginName,
      localName: tool.name,
      def: { ...tool, name: key },
    };
  }
  return out;
}
