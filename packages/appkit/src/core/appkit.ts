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
import type { TelemetryConfig } from "../telemetry";
import { TelemetryManager } from "../telemetry";

export class AppKit<TPlugins extends InputPluginMap> {
  private static _instance: AppKit<InputPluginMap> | null = null;
  private pluginInstances: Record<string, BasePlugin> = {};
  private setupPromises: Promise<void>[] = [];

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
          plugins: this.pluginInstances,
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

    this.pluginInstances[name] = pluginInstance;

    pluginInstance.validateEnv();

    this.setupPromises.push(pluginInstance.setup());

    Object.defineProperty(this, name, {
      get() {
        return this.pluginInstances[name];
      },
      enumerable: true,
    });
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
    const preparedPlugins = AppKit.preparePlugins(rawPlugins);
    const mergedConfig = {
      plugins: preparedPlugins,
    };

    AppKit._instance = new AppKit(mergedConfig);

    await Promise.all(AppKit._instance.setupPromises);

    return AppKit._instance as unknown as PluginMap<T>;
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
