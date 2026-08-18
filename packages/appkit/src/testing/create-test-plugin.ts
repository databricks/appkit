/**
 * `createTestPlugin` — instantiate a plugin from its factory the way AppKit
 * does, for the `createTestPluginContext` unit-test path.
 *
 * @module
 */

import type { PluginConstructor, PluginData } from "shared";

// Test fixtures intentionally use loose shapes; `no-explicit-any` is disabled
// repo-wide (see .oxlintrc.json), so a local alias keeps the intent readable.
type Any = any;

/**
 * Instantiate a plugin from the factory `toPlugin()` returned, applying the same
 * config merge AppKit applies at registration.
 *
 * Without this, unit-testing a plugin means reaching through the descriptor to
 * the class and newing it by hand:
 *
 * ```ts
 * const plugin = new (genie({}).plugin)({ name: "genie" }); // footgun
 * ```
 *
 * That skips `DEFAULT_CONFIG` and forgets `name`, so the instance under test is
 * configured differently from the one production builds. The merge order here
 * mirrors `AppKit.createAndRegisterPlugin`: `DEFAULT_CONFIG`, then the factory's
 * config, then the manifest `name`.
 *
 * `createTestApp` does not subsume this: the harness takes *descriptors* and
 * builds the instances itself, so the two paths need different ergonomics. Use
 * this one with `createTestPluginContext` when you want to unit-test wiring
 * without booting an app.
 *
 * @param factory - The plugin factory, e.g. `genie` or `analytics`.
 * @param config - Config for this instance. Wins over `DEFAULT_CONFIG`.
 * @returns A plugin instance configured as production would configure it.
 *
 * @example
 * ```ts
 * const plugin = createTestPlugin(genie, { spaceId: "s-1" });
 * const mock = createTestPluginContext();
 * await mock.attach(plugin);
 * ```
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

  const merged = {
    ...((PluginClass as Any).DEFAULT_CONFIG ?? {}),
    ...(factoryConfig ?? {}),
    name,
  };

  return new PluginClass(merged) as InstanceType<TClass>;
}
