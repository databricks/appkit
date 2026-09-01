import type {
  BasePlugin,
  CacheConfig,
  InputPluginMap,
  OptionalConfigPluginDef,
  PluginConstructor,
  PluginData,
  PluginMap,
} from "shared";

import { version as productVersion } from "../../package.json";
import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import {
  isInternalTelemetryEnabled,
  TelemetryReporter,
} from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { isPlainObject } from "../plugin/plugin";
import { uiVariants } from "../plugins/ui-variants";
import { ResourceRegistry, ResourceType } from "../registry";
import type { TelemetryConfig } from "../telemetry";
import { TelemetryManager } from "../telemetry";
import type { WorkspaceClient } from "../workspace-client";
import { LifecycleManager } from "./lifecycle-manager";
import { isToolProvider, PluginContext } from "./plugin-context";

const logger = createLogger("appkit");

export class AppKit<TPlugins extends InputPluginMap> {
  #pluginInstances: Record<string, BasePlugin> = {};
  #setupPromises: Promise<void>[] = [];
  #context: PluginContext;

  /**
   * @param context - The app's plugin context, already carrying this app's
   *   per-app services. A separate parameter, never a key on `config`: the
   *   `config` bag's leftovers are spread into every plugin's `baseConfig`
   *   (see {@link createAndRegisterPlugin}), and `_buildExecutionConfig`
   *   deep-merges a plugin's config into its execute options — so a
   *   `CacheManager` reaching plugin config would be merged into what
   *   `PluginExecuteConfig.cache` declares as a `CacheConfig` and silently
   *   break the cache interceptor's gate.
   */
  private constructor(config: { plugins: TPlugins }, context: PluginContext) {
    const { plugins, ...globalConfig } = config;

    this.#context = context;

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
        this.createAndRegisterPlugin(globalConfig, name, pluginData, {
          context: this.#context,
        });
      }
    }

    for (const [name, pluginData] of normalPlugins) {
      if (pluginData) {
        this.createAndRegisterPlugin(globalConfig, name, pluginData, {
          context: this.#context,
        });
      }
    }

    for (const [name, pluginData] of deferredPlugins) {
      if (pluginData) {
        this.createAndRegisterPlugin(globalConfig, name, pluginData, {
          context: this.#context,
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

    if (typeof pluginInstance.attachContext === "function") {
      pluginInstance.attachContext({
        context: this.#context,
        telemetryConfig: baseConfig.telemetry,
      });
    }

    this.#pluginInstances[name] = pluginInstance;

    this.#context.registerPlugin(name, pluginInstance);
    if (isToolProvider(pluginInstance)) {
      this.#context.registerToolProvider(name, pluginInstance);
    }

    this.#setupPromises.push(pluginInstance.setup());

    const self = this;

    // The manifest `name` is camelCase, so it doubles as the public handle key
    // (`appkit.aiSearch`). The kebab HTTP route is derived separately.
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
      } else if (isPlainObject(val)) {
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
   *
   * The OBO-side wrapping lives inside `Plugin.asUser` — calling
   * `plugin.asUser(req).exports()` returns exports whose functions already
   * run inside the user's AsyncLocalStorage scope. AppKit only adapts the
   * shape; it does not own the user-context concept.
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
      asUser: (req: import("express").Request) =>
        (plugin as any).asUser(req).exports() as Record<string, unknown>,
    };
  }

  static async _createApp<
    T extends PluginData<PluginConstructor, unknown, string>[],
  >(
    config: {
      plugins?: T;
      telemetry?: TelemetryConfig;
      cache?: CacheConfig;
      client?: WorkspaceClient;
      onPluginsReady?: (appkit: PluginMap<T>) => void | Promise<void>;
      disableInternalTelemetry?: boolean;
    } = {},
  ): Promise<PluginMap<T>> {
    // Initialize core services. Telemetry first: the CacheManager constructor
    // pulls a telemetry provider. The cache stays an await here — `create()`
    // builds its own workspace client before ServiceContext.initialize() runs,
    // so it cannot move into the synchronous AppKit constructor.
    TelemetryManager.initialize(config?.telemetry);
    const cache = await CacheManager.create(config?.cache);
    // Keeps the still-exported getInstanceSync() answering as it does today,
    // first-wins. Removed with the statics it serves.
    CacheManager._publishAmbient(cache);

    const withDefaults = AppKit.withDefaultPlugins(config.plugins as T);
    const rawPlugins = AppKit.filterDevOnlyPlugins(withDefaults);

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

    const instance = new AppKit(
      { plugins: AppKit.preparePlugins(rawPlugins) },
      new PluginContext({ cache }),
    );

    await Promise.all(instance.#setupPromises);
    await instance.#context.emitLifecycle("setup:complete");

    const handle = instance as unknown as PluginMap<T>;

    if (config.onPluginsReady) {
      logger.debug("Running onPluginsReady hook");
      await config.onPluginsReady(handle);
      logger.debug("onPluginsReady hook completed");
    }

    if (isInternalTelemetryEnabled(config)) {
      AppKit.bootstrapInternalTelemetry();
    }

    const serverPlugin = instance.#pluginInstances.server;
    if (serverPlugin && typeof (serverPlugin as any).start === "function") {
      await (serverPlugin as any).start();
    }

    // Core owns graceful shutdown: install the signal handlers once every
    // plugin has started. Applies uniformly whether or not a server plugin
    // is present — server-less apps still get their telemetry flushed and
    // plugin shutdown() hooks run.
    new LifecycleManager(instance.#context).installSignalHandlers();

    return handle;
  }

  private static bootstrapInternalTelemetry(): void {
    const serviceCtx = ServiceContext.get();
    const reporter = TelemetryReporter.initialize({
      workspaceId: serviceCtx.workspaceId,
      client: serviceCtx.client,
      appId: process.env.DATABRICKS_CLIENT_ID || "",
      appkitVersion: productVersion,
    });
    reporter.start();
    reporter.sendStartup().catch(() => {});
  }

  /**
   * Injects framework-owned default plugins the app author shouldn't have to
   * register by hand. Runs before {@link filterDevOnlyPlugins}, so a default
   * that is itself `devOnly` (like `ui-variants`) is present in dev and stripped
   * in prod through the exact same guard as any user plugin — never alive in a
   * deployed app.
   *
   * Currently injects the dev-only `ui-variants` recorder that backs the
   * `<Variants>` UI picker, so neither the developer nor their coding agent has
   * to remember to add it. If the app already registered it explicitly, that
   * entry wins and no duplicate is added.
   */
  private static withDefaultPlugins<
    T extends PluginData<PluginConstructor, unknown, string>[],
  >(plugins: T): T {
    const list = (plugins ?? []) as PluginData<
      PluginConstructor,
      unknown,
      string
    >[];

    const defaults: PluginData<PluginConstructor, unknown, string>[] = [
      uiVariants(),
    ];

    const missing = defaults.filter(
      (def) => !list.some((p) => p?.name === def.name),
    );

    return [...list, ...missing] as T;
  }

  /**
   * Drops plugins whose manifest declares `devOnly: true` unless
   * `NODE_ENV === "development"`. Runs before resource collection so a skipped
   * plugin is never constructed, never injects routes, and has its resource
   * requirements ignored — the framework, not the app author, enforces that
   * dev-only tooling can never run in a deployed app.
   *
   * This is the primary guard; plugins that expose a mutating dev endpoint
   * should still keep an in-handler `NODE_ENV` check as fail-safe defense
   * against being mounted through a path that bypasses this filter.
   */
  private static filterDevOnlyPlugins<
    T extends PluginData<PluginConstructor, unknown, string>[],
  >(plugins: T): T {
    if (!plugins || process.env.NODE_ENV === "development") return plugins;

    return plugins.filter((pluginData) => {
      const isDevOnly = pluginData?.plugin?.manifest?.devOnly === true;
      if (isDevOnly) {
        logger.debug(
          "Skipping dev-only plugin %s (NODE_ENV=%s)",
          pluginData?.name ?? "unknown",
          process.env.NODE_ENV ?? "<unset>",
        );
      }
      return !isDevOnly;
    }) as T;
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
 * If a `onPluginsReady` callback is provided it runs after plugin setup but
 * before the server starts, giving you access to the full appkit handle
 * for registering custom routes or performing async setup.
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
 * @example Server with custom routes via onPluginsReady
 * ```ts
 * import { createApp, server, analytics } from "@databricks/appkit";
 *
 * await createApp({
 *   plugins: [server(), analytics({})],
 *   onPluginsReady(appkit) {
 *     appkit.server.extend((app) => {
 *       app.get("/custom", (_req, res) => res.json({ ok: true }));
 *     });
 *   },
 * });
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
    onPluginsReady?: (appkit: PluginMap<T>) => void | Promise<void>;
    disableInternalTelemetry?: boolean;
  } = {},
): Promise<PluginMap<T>> {
  return AppKit._createApp(config);
}
