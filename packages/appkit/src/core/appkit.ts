import type {
  BasePlugin,
  BasePluginConfig,
  CacheConfig,
  InputPluginMap,
  OptionalConfigPluginDef,
  PluginConstructor,
  PluginData,
  PluginMap,
} from "shared";
import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { ConfigurationError } from "../errors";
import { createLogger } from "../logging";
import {
  getPluginManifest,
  ResourceRegistry,
  type ResourceRequirement,
} from "../registry";
import type { TelemetryConfig } from "../telemetry";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("appkit");

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
   */
  private bindExportMethods(
    exports: Record<string, unknown>,
    context: BasePlugin,
  ) {
    for (const key in exports) {
      if (Object.hasOwn(exports, key) && typeof exports[key] === "function") {
        exports[key] = (exports[key] as (...args: unknown[]) => unknown).bind(
          context,
        );
      }
    }
  }

  /**
   * Wraps a plugin's exports with an `asUser` method that returns
   * a user-scoped version of the exports.
   */
  private wrapWithAsUser<T extends BasePlugin>(plugin: T) {
    // If plugin doesn't implement exports(), return empty object
    const pluginExports = (plugin.exports?.() ?? {}) as Record<string, unknown>;
    this.bindExportMethods(pluginExports, plugin);

    // If plugin doesn't support asUser (no asUser method), return exports as-is
    if (typeof (plugin as any).asUser !== "function") {
      return pluginExports;
    }

    return {
      ...pluginExports,
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

  static async _createApp<
    T extends PluginData<PluginConstructor, unknown, string>[],
  >(
    config: {
      plugins?: T;
      telemetry?: TelemetryConfig;
      cache?: CacheConfig;
    } = {},
  ): Promise<PluginMap<T>> {
    // Initialize core services
    TelemetryManager.initialize(config?.telemetry);
    await CacheManager.getInstance(config?.cache);

    // Initialize ServiceContext for Databricks client management
    // This provides the service principal client and shared resources
    await ServiceContext.initialize();

    const rawPlugins = config.plugins as T;

    const registry = ResourceRegistry.getInstance();

    registry.clear();

    for (const pluginData of rawPlugins) {
      if (!pluginData?.plugin) continue;

      const pluginName = pluginData.name;

      // Load manifest and register static resources
      try {
        const manifest = getPluginManifest(pluginData.plugin);

        // Register required resources
        for (const resource of manifest.resources.required) {
          registry.register(pluginName, { ...resource, required: true });
        }

        // Register optional resources
        for (const resource of manifest.resources.optional || []) {
          registry.register(pluginName, { ...resource, required: false });
        }

        // Check for runtime resource requirements
        if (typeof pluginData.plugin.getResourceRequirements === "function") {
          const runtimeResources = pluginData.plugin.getResourceRequirements(
            pluginData.config as BasePluginConfig,
          );
          for (const resource of runtimeResources) {
            // Cast from shared's ResourceRequirement to registry's ResourceRequirement
            // The shared type has looser typing (string) vs registry (ResourceType enum)
            registry.register(pluginName, resource as ResourceRequirement);
          }
        }

        logger.debug(
          "Collected resources from plugin %s: %d total",
          pluginName,
          registry.getByPlugin(pluginName).length,
        );
      } catch (error) {
        // Plugin doesn't have a manifest - this is allowed for legacy plugins
        // or plugins that don't declare resources
        logger.debug(
          "Plugin %s has no manifest or invalid manifest: %s",
          pluginName,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const validation = registry.validate();
    const isDevelopment = process.env.NODE_ENV === "development";

    if (!validation.valid) {
      const errorMessage = ResourceRegistry.formatMissingResources(
        validation.missing,
      );

      if (isDevelopment) {
        // In development mode, warn but continue
        logger.warn(
          "Missing resources detected (continuing in dev mode):\n%s",
          errorMessage,
        );
      } else {
        // In production, throw error
        throw new ConfigurationError(errorMessage, {
          context: {
            missingResources: validation.missing.map((r) => ({
              type: r.type,
              alias: r.alias,
              plugin: r.plugin,
              envVars: Object.values(r.fields).map((f) => f.env),
            })),
          },
        });
      }
    } else if (registry.size() > 0) {
      logger.debug("All %d resources validated successfully", registry.size());
    }

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
 */
export async function createApp<
  T extends PluginData<PluginConstructor, unknown, string>[],
>(
  config: {
    plugins?: T;
    telemetry?: TelemetryConfig;
    cache?: CacheConfig;
  } = {},
): Promise<PluginMap<T>> {
  return AppKit._createApp(config);
}
