import type express from "express";
import type { BasePlugin, ToolProvider } from "shared";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("plugin-context");

interface BufferedRoute {
  method: string;
  path: string;
  handlers: express.RequestHandler[];
}

interface RouteTarget {
  addExtension(fn: (app: express.Application) => void): void;
}

interface ToolProviderEntry {
  plugin: BasePlugin & ToolProvider;
  name: string;
}

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
  private toolProviders = new Map<string, ToolProviderEntry>();
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
   */
  registerAsRouteTarget(target: RouteTarget): void {
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
   */
  registerToolProvider(name: string, plugin: BasePlugin & ToolProvider): void {
    this.toolProviders.set(name, { plugin, name });
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
   * and shutdown coordination.
   */
  getPlugins(): Map<string, BasePlugin> {
    return this.plugins;
  }

  /**
   * Returns all registered ToolProvider plugins.
   * Always returns the current set — not a frozen snapshot.
   */
  getToolProviders(): Array<{ name: string; provider: ToolProvider }> {
    return Array.from(this.toolProviders.values()).map((entry) => ({
      name: entry.name,
      provider: entry.plugin,
    }));
  }

  /**
   * Execute a tool on a ToolProvider plugin with automatic user scoping
   * and telemetry.
   *
   * The context:
   * 1. Resolves the plugin by name
   * 2. Calls `asUser(req)` for user-scoped execution
   * 3. Wraps the call in a telemetry span with a 30s timeout
   */
  async executeTool(
    req: express.Request,
    pluginName: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const entry = this.toolProviders.get(pluginName);
    if (!entry) {
      throw new Error(
        `PluginContext: unknown plugin "${pluginName}". Available: ${Array.from(this.toolProviders.keys()).join(", ")}`,
      );
    }

    const tracer = this.telemetry.getTracer();
    const operationName = `executeTool:${pluginName}.${toolName}`;

    return tracer.startActiveSpan(operationName, async (span) => {
      const timeout = 30_000;
      const timeoutSignal = AbortSignal.timeout(timeout);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      try {
        const userPlugin = (entry.plugin as any).asUser(req);
        const result = await (userPlugin as ToolProvider).executeAgentTool(
          toolName,
          args,
          combinedSignal,
        );
        span.setStatus({ code: 0 });
        return result;
      } catch (error) {
        span.setStatus({
          code: 2,
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

    for (const fn of hooks) {
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
 * Type guard: checks whether a plugin implements the ToolProvider interface.
 */
export function isToolProvider(
  plugin: unknown,
): plugin is BasePlugin & ToolProvider {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    "getAgentTools" in plugin &&
    typeof (plugin as ToolProvider).getAgentTools === "function" &&
    "executeAgentTool" in plugin &&
    typeof (plugin as ToolProvider).executeAgentTool === "function"
  );
}
