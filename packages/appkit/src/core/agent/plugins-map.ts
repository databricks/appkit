import type { Plugins, PluginToolkitProvider } from "./types";

/**
 * Wrap a plain `Record<string, PluginToolkitProvider>` so that accessing an
 * unknown plugin name throws with a named, actionable error instead of the
 * default `TypeError: Cannot read properties of undefined (reading 'toolkit')`
 * that surfaces from chained access on a missing key.
 *
 * The {@link Plugins} type is a `Record<string, PluginToolkitProvider>`
 * without `noUncheckedIndexedAccess` workspace-wide, so unknown keys type as
 * present at compile time but resolve to `undefined` at runtime. The proxy
 * closes that gap with a runtime error that names the missing plugin and
 * lists what's available — same shape as the agents plugin's pre-existing
 * "plugin is not registered" errors.
 *
 * @param entries - the resolved plugin map; the proxy serves these directly
 *   for known keys and throws for any other string key.
 * @param contextLabel - prefix included in the error message; differentiates
 *   the runtime context (e.g. `"runAgent: tools(plugins)"` vs
 *   `"AgentsPlugin: tools(plugins)"`) so users know which path to debug.
 */
export function createPluginsProxy(
  entries: Record<string, PluginToolkitProvider>,
  contextLabel: string,
): Plugins {
  return new Proxy(entries, {
    get(target, prop, receiver) {
      // Symbols and well-known string accessors (e.g. `Symbol.toPrimitive`,
      // `then` checked by Promise.resolve, `toJSON`) must pass through so
      // host code that probes the object doesn't hit the missing-plugin
      // error. Only named string-key access that misses is treated as a
      // user error.
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // Probes from runtime tooling (e.g. utility inspection, JSON
      // serialization, async-iterator detection) hit common property names
      // that are clearly not plugin lookups. Pass those through silently.
      if (
        prop === "then" ||
        prop === "toJSON" ||
        prop === "constructor" ||
        prop === "toString" ||
        prop === "valueOf"
      ) {
        return undefined;
      }
      const available = Object.keys(target).join(", ") || "(none)";
      throw new Error(
        `${contextLabel} referenced plugin '${prop}', but it is not registered. ` +
          `Available: ${available}.`,
      );
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  }) as Plugins;
}
