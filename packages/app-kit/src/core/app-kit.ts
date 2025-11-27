import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import type { TelemetryConfig } from "../telemetry";
import { TelemetryManager } from "../telemetry";
import type {
  BasePlugin,
  InputPluginMap,
  OptionalConfigPluginDef,
  PluginConstructor,
  PluginData,
  PluginMap,
  QuerySchemas,
} from "shared";
import { generatePluginTypes } from "./type-generator";
export class AppKit<TPlugins extends InputPluginMap> {
  private static _instance: AppKit<InputPluginMap> | null = null;
  private pluginInstances: Record<string, BasePlugin> = {};
  private setupPromises: Promise<void>[] = [];
  private schemaWatcher: FSWatcher | null = null;

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
    config: { plugins?: T; telemetry?: TelemetryConfig } = {},
  ): Promise<PluginMap<T>> {
    TelemetryManager.initialize(config.telemetry);

    const rawPlugins = config.plugins as T;
    const preparedPlugins = AppKit.preparePlugins(rawPlugins);
    const mergedConfig = {
      plugins: preparedPlugins,
    };

    AppKit._instance = new AppKit(mergedConfig);

    await Promise.all(AppKit._instance.setupPromises);

    if (process.env.NODE_ENV === "development") {
      AppKit._instance._generatePluginTypes(rawPlugins);
    }

    return AppKit._instance as unknown as PluginMap<T>;
  }

  cleanup() {
    if (this.schemaWatcher) {
      this.schemaWatcher.close();
      this.schemaWatcher = null;
    }
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

  private _generatePluginTypes(
    rawPlugins: PluginData<PluginConstructor, unknown, string>[],
  ) {
    const schemaDir = path.join(process.cwd(), "config/queries");
    const querySchemaPath = path.join(schemaDir, "schema.ts");

    const generate = () => {
      let querySchemas: QuerySchemas = {};

      try {
        delete require.cache[require.resolve(querySchemaPath)];
        querySchemas = require(querySchemaPath).querySchemas;
      } catch (error) {
        if (existsSync(querySchemaPath)) {
          console.warn(
            `[AppKit] Failed to load query schemas from ${querySchemaPath}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      generatePluginTypes(
        rawPlugins.map((p) => ({ name: p.name })),
        querySchemas,
      );
    };
    generate();

    if (this.schemaWatcher) {
      this.schemaWatcher.close();
      this.schemaWatcher = null;
    }

    if (existsSync(querySchemaPath)) {
      this.schemaWatcher = watch(
        schemaDir,
        { recursive: true },
        (_event, filename) => {
          if (filename?.endsWith(".ts")) {
            console.log(
              `[AppKit] Query schema changed, regenerating types for ${filename}`,
            );
            generate();
          }
        },
      );
    }
  }
}

export async function createApp<
  T extends PluginData<PluginConstructor, unknown, string>[],
>(config: { plugins?: T } = {}): Promise<PluginMap<T>> {
  return AppKit._createApp(config);
}
