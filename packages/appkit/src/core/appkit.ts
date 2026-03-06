import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type {
  BasePlugin,
  CacheConfig,
  InputPluginMap,
  OptionalConfigPluginDef,
  PluginConstructor,
  PluginData,
  PluginMap,
} from "shared";
import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { ResourceRegistry, ResourceType } from "../registry";
import type { TelemetryConfig } from "../telemetry";
import { TelemetryManager } from "../telemetry";

export class AppKit<TPlugins extends InputPluginMap> {
  #pluginInstances: Record<string, BasePlugin> = {};
  #setupPromises: Promise<void>[] = [];

  private constructor(config: { plugins: TPlugins }) {
    const { plugins, ...globalConfig } = config;

    const pluginEntries = Object.entries(plugins);

    const corePlugins = pluginEntries.filter(([_, p]) => {
      return (p?.plugin?.phase ?? "normal") === "core";
    });
    const normalPlugins = pluginEntries.filter(
      ([_, p]) => (p?.plugin?.phase ?? "normal") === "normal",
    );
    const deferredPlugins = pluginEntries.filter(
      ([_, p]) => (p?.plugin?.phase ?? "normal") === "deferred",
    );

    for (const [name, pluginData] of corePlugins) {
      if (pluginData) {
        this.createAndRegisterPlugin(globalConfig, name, pluginData);
      }
    }

    for (const [name, pluginData] of normalPlugins) {
      if (pluginData) {
        this.createAndRegisterPlugin(globalConfig, name, pluginData);
      }
    }

    for (const [name, pluginData] of deferredPlugins) {
      if (pluginData) {
        this.createAndRegisterPlugin(globalConfig, name, pluginData, {
          plugins: this.#pluginInstances,
        });
      }
    }
  }

  private createAndRegisterPlugin<T extends PluginConstructor>(
    config: Omit<{ plugins: TPlugins }, "plugins">,
    name: string,
    pluginData: OptionalConfigPluginDef<T>,
    extraData?: Record<string, unknown>,
  ) {
    const { plugin: Plugin, config: pluginConfig } = pluginData;
    const baseConfig = {
      ...config,
      ...Plugin.DEFAULT_CONFIG,
      ...pluginConfig,
      name,
      ...extraData,
    };
    const pluginInstance = new Plugin(baseConfig);

    this.#pluginInstances[name] = pluginInstance;

    this.#setupPromises.push(pluginInstance.setup());

    const self = this;

    Object.defineProperty(this, name, {
      get() {
        const plugin = self.#pluginInstances[name];
        return self.wrapWithAsUser(plugin);
      },
      enumerable: true,
    });
  }

  /**
   * Binds all function properties in an exports object to the given context.
   * Recurses into plain objects to handle nested APIs (e.g., volume APIs).
   */
  private bindExportMethods(
    exports: Record<string, unknown>,
    context: BasePlugin,
  ) {
    for (const key in exports) {
      if (!Object.hasOwn(exports, key)) continue;
      const val = exports[key];
      if (typeof val === "function") {
        exports[key] = (val as (...args: unknown[]) => unknown).bind(context);
      } else if (AppKit.isPlainObject(val)) {
        this.bindExportMethods(val as Record<string, unknown>, context);
      }
    }
  }

  /**
   * Wraps a plugin's exports with an `asUser` method that returns
   * a user-scoped version of the exports.
   *
   * When `exports()` returns a callable (function), it is returned as-is
   * since the plugin manages its own `asUser` per-call (e.g. files plugin).
   * When it returns a plain object, the standard `asUser` wrapper is added.
   */
  private wrapWithAsUser<T extends BasePlugin>(plugin: T) {
    // If plugin doesn't implement exports(), return empty object
    const pluginExports = plugin.exports?.() ?? {};

    // If exports is a function, the plugin manages its own asUser pattern
    if (typeof pluginExports === "function") {
      return pluginExports;
    }

    const objExports = pluginExports as Record<string, unknown>;
    this.bindExportMethods(objExports, plugin);

    // If plugin doesn't support asUser (no asUser method), return exports as-is
    if (typeof (plugin as any).asUser !== "function") {
      return objExports;
    }

    return {
      ...objExports,
      /**
       * Execute operations using the user's identity from the request.
       * Returns user-scoped exports where all methods execute with the
       * user's Databricks credentials instead of the service principal.
       */
      asUser: (req: import("express").Request) => {
        const userPlugin = (plugin as any).asUser(req);
        const userExports = (userPlugin.exports?.() ?? {}) as Record<
          string,
          unknown
        >;
        this.bindExportMethods(userExports, userPlugin);
        return userExports;
      },
    };
  }

  /**
   * Returns true if the value is a plain object (not an array, Date, etc.).
   */
  private static isPlainObject(
    value: unknown,
  ): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  static async _createApp<
    T extends PluginData<PluginConstructor, unknown, string>[],
  >(
    config: {
      plugins?: T;
      telemetry?: TelemetryConfig;
      cache?: CacheConfig;
      client?: WorkspaceClient;
    } = {},
  ): Promise<PluginMap<T>> {
    // Initialize core services
    TelemetryManager.initialize(config?.telemetry);
    await CacheManager.getInstance(config?.cache);

    const rawPlugins = config.plugins as T;

    // Collect manifest resources via registry
    const registry = new ResourceRegistry();
    registry.collectResources(rawPlugins);

    // Derive ServiceContext needs from what manifests declared
    const needsWarehouse = registry
      .getRequired()
      .some((r) => r.type === ResourceType.SQL_WAREHOUSE);
    await ServiceContext.initialize(
      { warehouseId: needsWarehouse },
      config?.client,
    );

    // Validate env vars
    registry.enforceValidation();

    const preparedPlugins = AppKit.preparePlugins(rawPlugins);
    const mergedConfig = {
      plugins: preparedPlugins,
    };

    const instance = new AppKit(mergedConfig);

    await Promise.all(instance.#setupPromises);

    return instance as unknown as PluginMap<T>;
  }

  private static preparePlugins(
    plugins: PluginData<PluginConstructor, unknown, string>[],
  ) {
    const result: InputPluginMap = {};
    for (const currentPlugin of plugins) {
      result[currentPlugin.name] = {
        plugin: currentPlugin.plugin,
        config: currentPlugin.config as Record<string, unknown>,
      };
    }
    return result;
  }
}

/**
 * Bootstraps AppKit with the provided configuration.
 *
 * Initializes telemetry, cache, and service context, then registers plugins
 * in phase order (core, normal, deferred) and awaits their setup.
 * The returned object maps each plugin name to its `exports()` API,
 * with an `asUser(req)` method for user-scoped execution.
 *
 * @returns A `PluginMap` keyed by plugin name with typed exports
 *
 * @example Minimal server
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 *
 * await createApp({
 *   plugins: [server()],
 * });
 * ```
 *
 * @example Extended Server with analytics and custom endpoint
 * ```ts
 * import { createApp, server, analytics } from "@databricks/appkit";
 *
 * const appkit = await createApp({
 *   plugins: [server({ autoStart: false }), analytics({})],
 * });
 *
 * appkit.server.extend((app) => {
 *   app.get("/custom", (_req, res) => res.json({ ok: true }));
 * });
 * await appkit.server.start();
 * ```
 */
export async function createApp<
  T extends PluginData<PluginConstructor, unknown, string>[],
>(
  config: {
    plugins?: T;
    telemetry?: TelemetryConfig;
    cache?: CacheConfig;
    client?: WorkspaceClient;
  } = {},
): Promise<PluginMap<T>> {
  return AppKit._createApp(config);
}
