import type {
  BasePlugin,
  PluginConstructor,
  PluginData,
  ToPlugin,
} from "shared";

/**
 * Factory function produced by `toPlugin` / `toPluginWithInstance`. Carries a
 * static `pluginName` field so tooling (e.g. `fromPlugin`) can identify which
 * plugin a factory references without constructing an instance.
 */
export type NamedPluginFactory<Name extends string = string> = {
  readonly pluginName: Name;
};

/**
 * Wraps a plugin class so it can be passed to createApp with optional config.
 * Infers config type from the constructor and plugin name from the static `name` property.
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
  const factory = (config: Config = {} as Config): PluginData<T, Config, Name> => ({
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

/**
 * Variant of `toPlugin` that eagerly constructs the plugin instance and
 * exposes it (plus any instance methods specified in `expose`) on the
 * returned `PluginData`. Lets users call plugin-level helpers like
 * `analytics().toolkit()` at module top-level. `AppKit._createApp` reuses the
 * eagerly constructed instance instead of constructing a new one.
 *
 * @internal
 */
export function toPluginWithInstance<
  T extends PluginConstructor,
  Methods extends readonly (keyof InstanceType<T>)[],
>(plugin: T, expose: Methods) {
  type Config = ConstructorParameters<T>[0];
  type Name = T["manifest"]["name"];
  type Instance = InstanceType<T>;
  type Exposed = Pick<Instance, Methods[number]>;

  const pluginName = plugin.manifest.name as Name;

  const factory = (
    config: Config = {} as Config,
  ): PluginData<T, Config, Name> & {
    instance: BasePlugin;
  } & Exposed => {
    const instance = new plugin({ ...(config ?? {}), name: pluginName }) as Instance;

    const exposed: Record<string, unknown> = {};
    for (const methodName of expose) {
      const bound = instance[methodName];
      if (typeof bound === "function") {
        exposed[methodName as string] = (bound as Function).bind(instance);
      } else {
        exposed[methodName as string] = bound;
      }
    }

    return {
      plugin: plugin as T,
      config: config as Config,
      name: pluginName,
      instance: instance as unknown as BasePlugin,
      ...(exposed as Exposed),
    };
  };

  Object.defineProperty(factory, "pluginName", {
    value: pluginName,
    writable: false,
    enumerable: true,
  });
  return factory as typeof factory & NamedPluginFactory<Name>;
}
