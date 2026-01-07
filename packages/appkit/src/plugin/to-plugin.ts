import type { PluginData, ToPlugin } from "shared";

/**
 * @internal
 */
export function toPlugin<T, U, N extends string>(
  plugin: T,
  name: N,
): ToPlugin<T, U, N> {
  return (config: U = {} as U): PluginData<T, U, N> => ({
    plugin: plugin as T,
    config: config as U,
    name,
  });
}
