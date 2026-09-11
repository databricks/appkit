import type { PluginConstructor, PluginData } from "shared";

/**
 * Instantiate a plugin from its `toPlugin()` factory for use with
 * `createTestPluginContext`.
 *
 * Merge order mirrors `AppKit.createAndRegisterPlugin` — `DEFAULT_CONFIG`, then
 * the factory's config, then the manifest `name` — so the instance matches what
 * production builds. Reaching through the descriptor by hand
 * (`new (genie({}).plugin)({})`) skips both.
 */
export function createTestPlugin<
  TClass extends PluginConstructor,
  TConfig,
  TName extends string,
>(
  factory: (config?: TConfig) => PluginData<TClass, TConfig, TName>,
  config?: TConfig,
): InstanceType<TClass> {
  const { plugin: PluginClass, config: factoryConfig, name } = factory(config);

  return new PluginClass({
    ...(PluginClass.DEFAULT_CONFIG ?? {}),
    ...(factoryConfig ?? {}),
    name,
  }) as InstanceType<TClass>;
}
