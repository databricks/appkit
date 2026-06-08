import type { PluginConstructor, PluginData, ToPlugin } from "shared";

/**
 * Wraps a plugin class so it can be passed to `createApp` with optional
 * config. Infers the config type from the constructor and the plugin name
 * from the static `manifest.name` property.
 *
 * @internal
 */
export function toPlugin<T extends PluginConstructor>(
  plugin: T,
): ToPlugin<T, ConstructorParameters<T>[0], T["manifest"]["name"]> {
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
  return factory as ToPlugin<T, Config, Name>;
}
