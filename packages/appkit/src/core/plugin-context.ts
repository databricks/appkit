import type express from "express";
import type { BasePlugin, IAppRequest, ToolProvider } from "shared";
import { createLogger } from "../logging/logger";
import { SpanStatusCode, TelemetryManager } from "../telemetry";

const logger = createLogger("plugin-context");

interface BufferedRoute {
  method: string;
  path: string;
  handlers: express.RequestHandler[];
}

interface RouteTarget {
  addExtension(fn: (app: express.Application) => void): void;
}

/**
 * A tool-provider plugin that also exposes user-scoped execution. Plugins
 * derived from {@link Plugin} satisfy this implicitly because `asUser` lives
 * on the base class. {@link isToolProvider} narrows to this shape so
 * `executeTool` can call `asUser` without an unsafe cast.
 */
type ToolProviderPlugin = BasePlugin &
  ToolProvider & { asUser: (req: IAppRequest) => ToolProvider };

type LifecycleEvent = "setup:complete" | "server:ready" | "shutdown";

/**
 * Mediator for inter-plugin communication.
 *
 * Created by AppKit core and passed to every plugin. Plugins request
 * capabilities from the context instead of holding direct references
 * to sibling plugin instances.
 *
 * Capabilities:
 * - Route mounting with buffering (order-independent)
 * - Typed ToolProvider registry (live, not snapshot-based)
 * - User-scoped tool execution with automatic telemetry
 * - Lifecycle hooks for plugin coordination
 */
export class PluginContext {
  private routeBuffer: BufferedRoute[] = [];
  private routeTarget: RouteTarget | null = null;
  private toolProviders = new Map<string, ToolProviderPlugin>();
  private plugins = new Map<string, BasePlugin>();
  private lifecycleHooks = new Map<
    LifecycleEvent,
    Set<() => void | Promise<void>>
  >();
  private telemetry = TelemetryManager.getProvider("plugin-context");

  /**
   * Register a route on the root Express application.
   *
   * If a route target (server plugin) has registered, the route is applied
   * immediately. Otherwise it is buffered and flushed when a route target
   * becomes available.
   */
  addRoute(
    method: string,
    path: string,
    ...handlers: express.RequestHandler[]
  ): void {
    if (this.routeTarget) {
      this.applyRoute({ method, path, handlers });
    } else {
      this.routeBuffer.push({ method, path, handlers });
    }
  }

  /**
   * Register middleware on the root Express application.
   *
   * Same buffering semantics as `addRoute`.
   */
  addMiddleware(path: string, ...handlers: express.RequestHandler[]): void {
    if (this.routeTarget) {
      this.applyMiddleware(path, handlers);
    } else {
      this.routeBuffer.push({ method: "use", path, handlers });
    }
  }

  /**
   * Called by the server plugin to opt in as the route target.
   * Flushes all buffered routes via the server's `addExtension`.
   *
   * Only the first caller wins — subsequent calls are ignored with a warning.
   * In practice only the server plugin registers, but a misconfigured app
   * (two server plugins, or duplicate AppKit setup in tests) would otherwise
   * silently drop the first target's later extensions.
   */
  registerAsRouteTarget(target: RouteTarget): void {
    if (this.routeTarget) {
      logger.warn(
        "registerAsRouteTarget called more than once; ignoring duplicate registration",
      );
      return;
    }
    this.routeTarget = target;

    for (const route of this.routeBuffer) {
      if (route.method === "use") {
        this.applyMiddleware(route.path, route.handlers);
      } else {
        this.applyRoute(route);
      }
    }
    this.routeBuffer = [];
  }

  /**
   * Register a plugin that implements the ToolProvider interface.
   * Called by AppKit core after constructing each plugin.
   *
   * Plugin names should be unique (they are derived from `manifest.name`).
   * A duplicate registration overwrites the previous entry and emits a
   * warning so the misconfiguration is visible in startup logs.
   */
  registerToolProvider(name: string, plugin: ToolProviderPlugin): void {
    if (this.toolProviders.has(name)) {
      logger.warn(
        'Tool provider "%s" registered more than once; the previous registration is being overwritten',
        name,
      );
    }
    this.toolProviders.set(name, plugin);
  }

  /**
   * Register a plugin instance.
   * Called by AppKit core after constructing each plugin.
   */
  registerPlugin(name: string, instance: BasePlugin): void {
    this.plugins.set(name, instance);
  }

  /**
   * Returns all registered plugin instances keyed by name.
   * Used by the server plugin for route injection, client config,
   * and shutdown coordination. The returned map is read-only at the
   * type level — callers must not mutate the live registry.
   */
  getPlugins(): ReadonlyMap<string, BasePlugin> {
    return this.plugins;
  }

  /**
   * Returns all registered ToolProvider plugins.
   * Always returns the current set — not a frozen snapshot.
   */
  getToolProviders(): Array<{ name: string; provider: ToolProvider }> {
    return Array.from(this.toolProviders.entries()).map(([name, provider]) => ({
      name,
      provider,
    }));
  }

  /**
   * Execute a tool on a ToolProvider plugin with automatic user scoping
   * and telemetry.
   *
   * The context:
   * 1. Resolves the plugin by name
   * 2. Calls `asUser(req)` for user-scoped execution
   * 3. Wraps the call in a telemetry span with a configurable timeout
   *
   * @param timeoutMs Per-call timeout. Defaults to 5 minutes — the floor
   *   for cold SQL Warehouse round-trips, long Genie conversations, and
   *   busy serverless Lakebase queries. The agents plugin overrides this
   *   per-app via `agents({ limits: { toolCallTimeoutMs } })`.
   */
  async executeTool(
    req: express.Request,
    pluginName: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
    timeoutMs: number = 300_000,
  ): Promise<unknown> {
    const provider = this.toolProviders.get(pluginName);
    if (!provider) {
      throw new Error(
        `PluginContext: unknown plugin "${pluginName}". Available: ${Array.from(this.toolProviders.keys()).join(", ")}`,
      );
    }

    const tracer = this.telemetry.getTracer();
    const operationName = `executeTool:${pluginName}.${toolName}`;

    return tracer.startActiveSpan(operationName, async (span) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      try {
        const userScoped = provider.asUser(req);
        const result = await userScoped.executeAgentTool(
          toolName,
          args,
          combinedSignal,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message:
            error instanceof Error ? error.message : "Tool execution failed",
        });
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Register a lifecycle hook callback.
   */
  onLifecycle(event: LifecycleEvent, fn: () => void | Promise<void>): void {
    let hooks = this.lifecycleHooks.get(event);
    if (!hooks) {
      hooks = new Set();
      this.lifecycleHooks.set(event, hooks);
    }
    hooks.add(fn);
  }

  /**
   * Emit a lifecycle event, calling all registered callbacks.
   * Errors in individual callbacks are logged but do not prevent
   * other callbacks from running.
   *
   * @internal Called by AppKit core only.
   */
  async emitLifecycle(event: LifecycleEvent): Promise<void> {
    const hooks = this.lifecycleHooks.get(event);
    if (!hooks) return;

    if (
      event === "setup:complete" &&
      this.routeBuffer.length > 0 &&
      !this.routeTarget
    ) {
      logger.warn(
        "%d buffered routes were never applied — no server plugin registered as route target",
        this.routeBuffer.length,
      );
    }

    // Snapshot before iterating so a callback that registers a new hook for
    // the same event does not mutate the loop. ECMAScript Set iteration would
    // otherwise visit late-added entries, risking unexpected re-entry.
    for (const fn of [...hooks]) {
      try {
        await fn();
      } catch (error) {
        logger.error("Lifecycle hook '%s' failed: %O", event, error);
      }
    }
  }

  /**
   * Returns all registered plugin names.
   */
  getPluginNames(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Check if a plugin with the given name is registered.
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  private applyRoute(route: BufferedRoute): void {
    if (!this.routeTarget) return;
    this.routeTarget.addExtension((app) => {
      const method = route.method.toLowerCase() as keyof express.Application;
      if (typeof app[method] === "function") {
        (app[method] as (...a: unknown[]) => void)(
          route.path,
          ...route.handlers,
        );
      }
    });
  }

  private applyMiddleware(
    path: string,
    handlers: express.RequestHandler[],
  ): void {
    if (!this.routeTarget) return;
    this.routeTarget.addExtension((app) => {
      app.use(path, ...handlers);
    });
  }
}

/**
 * Type guard: checks whether a plugin implements the ToolProvider interface
 * and exposes the user-scoped `asUser` helper that the {@link Plugin} base
 * class provides. Narrowing to {@link ToolProviderPlugin} lets `executeTool`
 * call `asUser` without an unsafe cast.
 */
export function isToolProvider(plugin: unknown): plugin is ToolProviderPlugin {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    "getAgentTools" in plugin &&
    typeof (plugin as ToolProvider).getAgentTools === "function" &&
    "executeAgentTool" in plugin &&
    typeof (plugin as ToolProvider).executeAgentTool === "function" &&
    "asUser" in plugin &&
    typeof (plugin as { asUser?: unknown }).asUser === "function"
  );
}
