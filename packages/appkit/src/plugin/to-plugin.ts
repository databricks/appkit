import type { PluginConstructor, PluginData, ToPlugin } from "shared";

/**
 * Factory function produced by {@link toPlugin}. Carries a static
 * `pluginName` field so tooling (e.g. `fromPlugin`) can identify which
 * plugin a factory references without constructing an instance.
 */
export type NamedPluginFactory<Name extends string = string> = {
  readonly pluginName: Name;
};

/**
 * Wraps a plugin class so it can be passed to `createApp` with optional
 * config. Infers the config type from the constructor and the plugin name
 * from the static `manifest.name` property, and stamps `pluginName` onto
 * the returned factory function so `fromPlugin` can identify the plugin
 * without needing to construct it.
 *
 * @internal
 */
export function toPlugin<T extends PluginConstructor>(
  plugin: T,
): ToPlugin<T, ConstructorParameters<T>[0], T["manifest"]["name"]> &
  NamedPluginFactory<T["manifest"]["name"]> {
  type Config = ConstructorParameters<T>[0];
  type Name = T["manifest"]["name"];
  const pluginName = plugin.manifest.name as Name;
  const factory = (
    config: Config = {} as Config,
  ): PluginData<T, Config, Name> => ({
    plugin: plugin as T,
    config: config as Config,
    name: pluginName,
  });
  Object.defineProperty(factory, "pluginName", {
    value: pluginName,
    writable: false,
    enumerable: true,
  });
  return factory as ToPlugin<T, Config, Name> & NamedPluginFactory<Name>;
}
