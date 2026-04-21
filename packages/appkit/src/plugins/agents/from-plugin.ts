import type { NamedPluginFactory } from "../../plugin/to-plugin";
import type { ToolkitOptions } from "./types";

/**
 * Symbol brand for the `fromPlugin` marker. Using a globally-interned symbol
 * (`Symbol.for`) keeps the brand stable across module boundaries / bundle
 * duplicates so `isFromPluginMarker` stays reliable.
 */
export const FROM_PLUGIN_MARKER = Symbol.for(
  "@databricks/appkit.fromPluginMarker",
);

/**
 * A lazy reference to a plugin's tools, produced by {@link fromPlugin} and
 * resolved to concrete `ToolkitEntry`s at `AgentsPlugin.setup()` time.
 *
 * The marker is spread under a unique symbol key so multiple calls to
 * `fromPlugin` (even for the same plugin) coexist in an `AgentDefinition.tools`
 * record without colliding.
 */
export interface FromPluginMarker {
  readonly [FROM_PLUGIN_MARKER]: true;
  readonly pluginName: string;
  readonly opts: ToolkitOptions | undefined;
}

/**
 * Record shape returned by {@link fromPlugin} — a single symbol-keyed entry
 * suitable for spreading into `AgentDefinition.tools`.
 */
export type FromPluginSpread = { readonly [key: symbol]: FromPluginMarker };

/**
 * Reference a plugin's tools inside an `AgentDefinition.tools` record without
 * naming the plugin instance. The returned spread-friendly object carries a
 * symbol-keyed marker that the agents plugin resolves against registered
 * `ToolProvider`s at setup time.
 *
 * The factory argument must come from `toPlugin` (or any function that
 * carries a `pluginName` field). `fromPlugin` reads `factory.pluginName`
 * synchronously — it does not construct an instance.
 *
 * If the referenced plugin is also registered in `createApp({ plugins })`, the
 * same runtime instance is used for dispatch. If the plugin is missing,
 * `AgentsPlugin.setup()` throws with a clear `Available: …` listing.
 *
 * @example
 * ```ts
 * import { analytics, createAgent, files, fromPlugin, tool } from "@databricks/appkit";
 *
 * const support = createAgent({
 *   instructions: "You help customers.",
 *   tools: {
 *     ...fromPlugin(analytics),
 *     ...fromPlugin(files, { only: ["uploads.read"] }),
 *     get_weather: tool({ ... }),
 *   },
 * });
 * ```
 *
 * @param factory A plugin factory produced by `toPlugin`. Must expose a
 *   `pluginName` field.
 * @param opts Optional toolkit scoping — `prefix`, `only`, `except`, `rename`.
 *   Same shape as the `.toolkit()` method.
 */
export function fromPlugin<F extends NamedPluginFactory>(
  factory: F,
  opts?: ToolkitOptions,
): FromPluginSpread {
  if (
    !factory ||
    typeof factory.pluginName !== "string" ||
    !factory.pluginName
  ) {
    throw new Error(
      "fromPlugin(): factory is missing pluginName. Pass a factory created by toPlugin().",
    );
  }
  const pluginName = factory.pluginName;
  const marker: FromPluginMarker = {
    [FROM_PLUGIN_MARKER]: true,
    pluginName,
    opts,
  };
  return { [Symbol(`fromPlugin:${pluginName}`)]: marker };
}

/**
 * Type guard for {@link FromPluginMarker}.
 */
export function isFromPluginMarker(value: unknown): value is FromPluginMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[FROM_PLUGIN_MARKER] === true
  );
}
