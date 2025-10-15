import { AuthManager } from "@databricks-apps/auth";
import type {
  InputPluginMap,
  OptionalConfigPluginDef,
  PluginConstructor,
  PluginData,
  PluginMap,
} from "@databricks-apps/types";

import { validateEnv } from "@databricks-apps/utils";
import { envVars } from "./env";

export class DBX<TPlugins extends InputPluginMap> {
  private config: { plugins: TPlugins };
  private static initialized = false;
  private static _instance: any = null;
  private pluginInstances: Record<string, any> = {};
  private auth: AuthManager;
  private setupPromises: Promise<void>[] = [];

  private constructor(config: { plugins: TPlugins }) {
    validateEnv(envVars);

    this.config = config;
    // TODO: think about a way of injecting the auth manager into the plugins instead of creating a new instance here
    // We will probably want to create some kind of context that provides more services like auth, telemetry, etc.
    this.auth = new AuthManager();

    const { plugins, ...globalConfig } = config;

    const pluginEntries = Object.entries(plugins);

    const corePlugins = pluginEntries.filter(([_, p]) => {
      return (p?.plugin?.phase ?? "normal") === "core";
    });
    const normalPlugins = pluginEntries.filter(
      ([_, p]) => (p?.plugin?.phase ?? "normal") === "normal"
    );
    const deferredPlugins = pluginEntries.filter(
      ([_, p]) => (p?.plugin?.phase ?? "normal") === "deferred"
    );

    for (const [name, pluginData] of corePlugins) {
      this.createAndRegisterPlugin(
        globalConfig,
        name,
        pluginData as OptionalConfigPluginDef<any>
      );
    }

    for (const [name, pluginData] of normalPlugins) {
      this.createAndRegisterPlugin(
        globalConfig,
        name,
        pluginData as OptionalConfigPluginDef<any>
      );
    }

    for (const [name, pluginData] of deferredPlugins) {
      this.createAndRegisterPlugin(
        globalConfig,
        name,
        pluginData as OptionalConfigPluginDef<any>,
        { plugins: this.pluginInstances }
      );
    }
  }

  private createAndRegisterPlugin<T extends PluginConstructor>(
    config: any,
    name: string,
    pluginData: OptionalConfigPluginDef<T>,
    extraData?: { [key: string]: any }
  ) {
    const { plugins, ...globalConfig } = config;
    const { plugin: Plugin, config: pluginConfig } = pluginData;
    const pluginInstance = new (Plugin as any)(
      {
        ...globalConfig,
        ...(Plugin.DEFAULT_CONFIG || {}),
        ...pluginConfig,
        name,
        ...extraData,
      },
      this.auth
    );

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

  static async init<T extends PluginData<any, any, string>[]>(
    config: { plugins?: T } = {}
  ): Promise<PluginMap<T>> {
    const rawPlugins = config.plugins as T;
    const preparedPlugins = DBX.preparePlugins(rawPlugins);
    const mergedConfig = {
      plugins: preparedPlugins,
    };

    DBX._instance = new DBX(mergedConfig);

    await Promise.all(DBX._instance.setupPromises);

    DBX.initialized = true;

    return DBX._instance;
  }

  private static preparePlugins(plugins: PluginData<any, any, string>[]) {
    return plugins.reduce((acc, currentPlugin) => {
      return {
        ...acc,
        [currentPlugin.name]: {
          plugin: currentPlugin.plugin,
          config: currentPlugin.config,
        },
      };
    }, {} as Record<string, { plugin: any; config: any }>);
  }
}
