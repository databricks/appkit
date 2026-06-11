import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import getPort, { portNumbers } from "get-port";
import type { BasePlugin, PluginClientConfigs, PluginPhase } from "shared";
import { CacheManager } from "../../cache";
import { ServerError } from "../../errors";
import { TelemetryReporter } from "../../internal-telemetry";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { instrumentations, TelemetryManager } from "../../telemetry";
import { sanitizeClientConfig } from "./client-config-sanitizer";
import manifest from "./manifest.json";
import { RemoteTunnelController } from "./remote-tunnel/remote-tunnel-controller";
import { StaticServer } from "./static-server";
import type { ServerConfig } from "./types";
import { getRoutes, type PluginEndpoints, printRoutes } from "./utils";
import { ViteDevServer } from "./vite-dev-server";

dotenv.config({ path: path.resolve(process.cwd(), "./.env") });

const logger = createLogger("server");

/** Dev-only: try `requested` then consecutive ports (see `get-port` `portNumbers`). */
const devListenPortSpan = 100;

/**
 * Server plugin for the AppKit.
 *
 * This plugin is responsible for starting the server and serving the static files.
 * It also handles the remote tunneling for development purposes.
 *
 * The server is started automatically by `createApp` after all plugins are set up
 * and the optional `onPluginsReady` callback has run.
 *
 * @example
 * ```ts
 * createApp({
 *   plugins: [server(), analytics({})],
 *   onPluginsReady(appkit) {
 *     appkit.server.extend((app) => {
 *       app.get("/custom", (_req, res) => res.json({ ok: true }));
 *     });
 *   },
 * });
 * ```
 *
 */
export class ServerPlugin extends Plugin {
  public static DEFAULT_CONFIG = {
    host: process.env.FLASK_RUN_HOST || "0.0.0.0",
    port: Number(process.env.DATABRICKS_APP_PORT) || 8000,
  };

  /**
   * Overall graceful-shutdown budget before the process is force-exited.
   *
   * Budget arithmetic: plugin `shutdown()` hooks run concurrently and are
   * bounded by {@link PLUGIN_SHUTDOWN_TIMEOUT_MS} (10s); the lifecycle emit
   * is bounded by {@link PHASE_SHUTDOWN_TIMEOUT_MS} (2s); the cache storage
   * close and the telemetry flush run concurrently, each bounded by
   * {@link PHASE_SHUTDOWN_TIMEOUT_MS} (2s). Worst case is
   * 10s + 2s + max(2s, 2s) = 14s, leaving ~1s of margin for the remaining
   * steps (aborts, socket teardown) before this timer force-exits.
   *
   * The `server.close()` await (after `closeAllConnections()`) is unbounded
   * by design: `closeAllConnections()` runs immediately before it, so it is
   * expected to resolve promptly, and the force-exit timer is the backstop
   * if it does not.
   */
  private static readonly SHUTDOWN_TIMEOUT_MS = 15_000;
  /**
   * Per-plugin budget for `shutdown()` hooks. Sized to cover the longest
   * built-in drain (the files plugin waits up to 10s for in-flight writes).
   */
  private static readonly PLUGIN_SHUTDOWN_TIMEOUT_MS = 10_000;
  /**
   * Budget for each non-plugin shutdown phase (the `"shutdown"` lifecycle
   * emit, the cache storage close, and the telemetry flush). Keeps the
   * worst-case total under {@link SHUTDOWN_TIMEOUT_MS} — see the arithmetic
   * there.
   */
  private static readonly PHASE_SHUTDOWN_TIMEOUT_MS = 2_000;

  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"server">;
  private serverApplication: express.Application;
  private server: HTTPServer | null;
  private viteDevServer?: ViteDevServer;
  private remoteTunnelController?: RemoteTunnelController;
  /** Bound listen port after optional dev-time resolution. */
  private resolvedListenPort?: number;
  protected declare config: ServerConfig;
  private serverExtensions: ((app: express.Application) => void)[] = [];
  private rawBodyPaths: Set<string> = new Set();
  /**
   * Guards against re-entrant shutdown (e.g. SIGTERM followed by SIGINT).
   * The flag set in `_gracefulShutdown` must remain synchronous and first —
   * any `await` before it would open a window for a second signal to
   * re-enter the sequence.
   */
  private isShuttingDown = false;
  /**
   * Name of the shutdown phase currently in flight, so the force-exit log
   * can say where shutdown got stuck without extra bookkeeping.
   */
  private shutdownPhase = "not started";
  static phase: PluginPhase = "deferred";

  constructor(config: ServerConfig) {
    super(config);
    if ("autoStart" in config) {
      throw new ServerError(
        "server({ autoStart }) has been removed. " +
          "The server is now started automatically by createApp.\n\n" +
          "Run `npx appkit codemod on-plugins-ready --write` to auto-migrate.",
      );
    }
    this.config = config;
    this.serverApplication = express();
    this.server = null;
    this.serverExtensions = [];
  }

  attachContext(deps: Parameters<Plugin["attachContext"]>[0] = {}): void {
    super.attachContext(deps);
    this.telemetry.registerInstrumentations([
      instrumentations.http,
      instrumentations.express,
    ]);
    this.context?.registerAsRouteTarget(this);
  }

  /** Setup the server plugin. */
  async setup() {}

  /** Get the server configuration. */
  getConfig() {
    const { plugins: _plugins, ...config } = this.config;

    return config;
  }

  /**
   * Start the server.
   *
   * This method starts the server and sets up the frontend.
   * It also sets up the remote tunneling if enabled.
   *
   * @returns The express application.
   */
  async start(): Promise<express.Application> {
    this.serverApplication.use(requestMetricsMiddleware);
    this.serverApplication.use(
      express.json({
        // Express's stock 100kb default is too tight for modern apps —
        // agent chat payloads and any base64-encoded upload (e.g. the
        // dev playground's smart-dashboard "save view" screenshot at
        // ~105KB) blow past it instantly. Raise to 1mb by default and
        // let consumers tune via `server({ bodyLimit })` if they need
        // more headroom.
        limit: this.config.bodyLimit ?? "1mb",
        type: (req) => {
          // Skip JSON parsing for routes that declared skipBodyParsing
          // (e.g. file uploads where the raw body must flow through).
          // rawBodyPaths is populated by extendRoutes() below; the type
          // callback runs per-request so the set is already filled.
          const urlPath = req.url?.split("?")[0];
          if (urlPath && this.rawBodyPaths.has(urlPath)) return false;
          const ct = req.headers["content-type"] ?? "";
          return ct.includes("json");
        },
      }),
    );

    const { endpoints, pluginConfigs } = await this.extendRoutes();

    for (const extension of this.serverExtensions) {
      extension(this.serverApplication);
    }

    // register remote tunnel controller (before static/vite)
    this.remoteTunnelController = new RemoteTunnelController(
      this.devFileReader,
    );
    this.serverApplication.use(this.remoteTunnelController.middleware);

    await this.setupFrontend(endpoints, pluginConfigs);

    const listenPort = await this.resolveListenPort();

    const server = this.serverApplication.listen(
      listenPort,
      this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host,
      () => this.logStartupInfo(),
    );

    this.server = server;

    // attach server to remote tunnel controller
    this.remoteTunnelController.setServer(server);

    // With a server present, this plugin owns the telemetry flush: it is
    // awaited inside _gracefulShutdown() after plugin hooks have run.
    // Remove the TelemetryManager's standalone signal handlers so they
    // cannot start the flush early (see TelemetryManager.disownSignalHandlers).
    TelemetryManager.getInstance().disownSignalHandlers();
    process.once("SIGTERM", () => this._gracefulShutdown());
    process.once("SIGINT", () => this._gracefulShutdown());

    if (process.env.NODE_ENV === "development") {
      const allRoutes = getRoutes(this.serverApplication._router.stack);
      printRoutes(allRoutes);
    }
    return this.serverApplication;
  }

  /**
   * Get the low level node.js http server instance.
   *
   * Only use this method if you need to access the server instance for advanced usage like a custom websocket server, etc.
   *
   * @throws {Error} If the server has not started yet.
   * @returns {HTTPServer} The server instance.
   */
  getServer(): HTTPServer {
    if (!this.server) {
      throw ServerError.notStarted();
    }

    return this.server;
  }

  /**
   * Extend the server with custom routes or middleware.
   *
   * Call this inside the `onPluginsReady` callback of `createApp` to register
   * custom Express routes or middleware before the server starts listening.
   *
   * @param fn - A function that receives the express application.
   * @returns The server plugin instance for chaining.
   */
  extend(fn: (app: express.Application) => void) {
    this.serverExtensions.push(fn);
    return this;
  }

  /**
   * Register a server extension from another plugin during setup.
   * Unlike extend(), this is designed for internal plugin-to-plugin
   * coordination where extensions are registered before the server starts
   * listening — typically called by PluginContext when flushing buffered routes.
   */
  addExtension(fn: (app: express.Application) => void) {
    this.serverExtensions.push(fn);
  }

  /**
   * Setup the routes with the plugins.
   *
   * This method goes through all the plugins and injects the routes into the server application.
   * Returns a map of plugin names to their registered named endpoints,
   * and a map of plugin names to their client-exposed configs.
   */
  private async extendRoutes(): Promise<{
    endpoints: PluginEndpoints;
    pluginConfigs: PluginClientConfigs;
  }> {
    const endpoints: PluginEndpoints = {};
    const pluginConfigs: PluginClientConfigs = {};

    const plugins = this.context?.getPlugins();
    if (!plugins || plugins.size === 0) return { endpoints, pluginConfigs };

    this.serverApplication.get("/health", (_, res) => {
      res.status(200).json({ status: "ok" });
    });
    this.registerEndpoint("health", "/health");

    for (const plugin of plugins.values()) {
      if (EXCLUDED_PLUGINS.includes(plugin.name)) continue;

      if (plugin?.injectRoutes && typeof plugin.injectRoutes === "function") {
        const router = express.Router();

        plugin.injectRoutes(router);

        const basePath = `/api/${plugin.name}`;
        this.serverApplication.use(basePath, router);

        endpoints[plugin.name] = plugin.getEndpoints();

        // Collect paths that should skip body parsing
        if (
          plugin.getSkipBodyParsingPaths &&
          typeof plugin.getSkipBodyParsingPaths === "function"
        ) {
          for (const p of plugin.getSkipBodyParsingPaths()) {
            this.rawBodyPaths.add(p);
          }
        }
      }

      if (typeof plugin.clientConfig === "function") {
        try {
          const raw = plugin.clientConfig();
          if (raw != null) {
            const sanitized = sanitizeClientConfig(plugin.name, raw);
            if (Object.keys(sanitized).length > 0) {
              pluginConfigs[plugin.name] = sanitized;
            }
          }
        } catch (error) {
          logger.error(
            "Plugin '%s' clientConfig() failed, skipping its config: %O",
            plugin.name,
            error,
          );
        }
      }
    }

    return { endpoints, pluginConfigs };
  }

  /**
   * Setup frontend serving based on environment:
   * - If staticPath is explicitly provided: use static server
   * - Dev mode (no staticPath): Vite for HMR
   * - Production (no staticPath): Static files auto-detected
   */
  private async setupFrontend(
    endpoints: PluginEndpoints,
    pluginConfigs: PluginClientConfigs,
  ) {
    const isDev = process.env.NODE_ENV === "development";
    const hasExplicitStaticPath = this.config.staticPath !== undefined;

    // explict static path provided
    if (hasExplicitStaticPath) {
      const staticServer = new StaticServer(
        this.serverApplication,
        this.config.staticPath as string,
        endpoints,
        pluginConfigs,
      );
      staticServer.setup();
      return;
    }

    // auto-detection based on environment
    if (isDev) {
      this.viteDevServer = new ViteDevServer(
        this.serverApplication,
        endpoints,
        pluginConfigs,
      );
      await this.viteDevServer.setup();
      return;
    }

    // auto-detection based on static path
    const staticPath = ServerPlugin.findStaticPath();
    if (staticPath) {
      const staticServer = new StaticServer(
        this.serverApplication,
        staticPath,
        endpoints,
        pluginConfigs,
      );

      staticServer.setup();
    }
  }

  private static findStaticPath() {
    const staticPaths = ["dist", "client/dist", "build", "public", "out"];
    const cwd = process.cwd();
    for (const p of staticPaths) {
      const fullPath = path.resolve(cwd, p);
      if (fs.existsSync(path.resolve(fullPath, "index.html"))) {
        logger.debug("Static files: serving from %s", fullPath);
        return fullPath;
      }
    }
    return undefined;
  }

  /**
   * In development, prefers {@link ServerConfig.port} / env / default (8000), then
   * scans upward using `get-port`'s `portNumbers()` on the listen host until one binds.
   * In non-development, uses config / env / default only (no fallback).
   */
  private async resolveListenPort(): Promise<number> {
    const requested = this.config.port ?? ServerPlugin.DEFAULT_CONFIG.port;

    if (process.env.NODE_ENV !== "development") {
      this.resolvedListenPort = requested;
      return requested;
    }

    const host = this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host;
    const upper = Math.min(requested + devListenPortSpan - 1, 65_535);
    const port = await getPort({
      host,
      port: portNumbers(requested, upper),
    });
    this.resolvedListenPort = port;
    if (port !== requested) {
      logger.info("Port %d was busy, picking %d", requested, port);
    }
    return port;
  }

  private logStartupInfo() {
    const isDev = process.env.NODE_ENV === "development";
    const hasExplicitStaticPath = this.config.staticPath !== undefined;
    const port =
      this.resolvedListenPort ??
      this.config.port ??
      ServerPlugin.DEFAULT_CONFIG.port;
    const host = this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host;

    logger.info("Server running on http://%s:%d", host, port);

    if (hasExplicitStaticPath) {
      logger.info("Mode: static (%s)", this.config.staticPath);
    } else if (isDev) {
      logger.info("Mode: development (Vite HMR)");
    } else {
      logger.info("Mode: production (static)");
    }

    const remoteServerController = this.remoteTunnelController;
    if (!remoteServerController) {
      logger.debug("Remote tunnel: disabled (controller not initialized)");
    } else {
      logger.debug(
        "Remote tunnel: %s; %s",
        remoteServerController.isAllowedByEnv() ? "allowed" : "blocked",
        remoteServerController.isActive() ? "active" : "inactive",
      );
    }
  }

  private async _gracefulShutdown() {
    // Must stay synchronous and first: any await before the flag is set
    // would let a second signal re-enter the shutdown sequence.
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info("Starting graceful shutdown...");

    // Force exit once the overall budget is spent. Exit 0 is deliberate:
    // a force-timeout still happens on a routine deploy (deliberate
    // shutdown, not a crash), and orchestrators record nonzero exits on
    // deploys as crashes. The error log below is the stuck-shutdown
    // signal instead of the exit code.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        "Graceful shutdown did NOT complete within the %dms budget (phase in flight: %s); force-exiting with code 0.",
        ServerPlugin.SHUTDOWN_TIMEOUT_MS,
        this.shutdownPhase,
      );
      process.exit(0);
    }, ServerPlugin.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      this.shutdownPhase = "dev servers and tunnel cleanup";
      if (this.viteDevServer) {
        await this.viteDevServer.close();
      }

      if (this.remoteTunnelController) {
        this.remoteTunnelController.cleanup();
      }

      TelemetryReporter.getInstance()?.stop();

      const plugins = this.context
        ? Array.from(this.context.getPlugins().values())
        : [];

      // 1. abort active operations from plugins (in-flight executions,
      //    SSE streams). Cancellation only — resource teardown (e.g. the
      //    lakebase pools) belongs in plugin shutdown() hooks so other
      //    plugins can still drain state through them.
      this.shutdownPhase = "aborting active operations";
      for (const plugin of plugins) {
        if (plugin.abortActiveOperations) {
          try {
            plugin.abortActiveOperations();
          } catch (err) {
            logger.error(
              "Error aborting operations for plugin %s: %O",
              plugin.name,
              err,
            );
          }
        }
      }

      // 2. stop accepting new connections and drop idle keep-alive sockets.
      //    Without this, any connected browser pins `server.close()` open
      //    until the force-exit timeout fires.
      let serverClosed: Promise<void> | undefined;
      if (this.server) {
        const server = this.server;
        serverClosed = new Promise((resolve) => {
          server.close(() => resolve());
        });
        server.closeIdleConnections();
      }

      // 3. run every plugin's shutdown() hook concurrently, each bounded
      //    by a per-plugin timeout so one hung plugin cannot stall exit.
      this.shutdownPhase = "plugin shutdown() hooks";
      await Promise.all(
        plugins
          .filter((plugin) => typeof plugin.shutdown === "function")
          .map((plugin) => this.runPluginShutdown(plugin)),
      );

      // 4. notify lifecycle subscribers, bounded so a slow subscriber
      //    cannot eat the remaining budget.
      this.shutdownPhase = "shutdown lifecycle emit";
      try {
        await this.raceWithTimeout(
          this.context?.emitLifecycle("shutdown"),
          ServerPlugin.PHASE_SHUTDOWN_TIMEOUT_MS,
          "shutdown lifecycle emit",
        );
      } catch (err) {
        logger.error("Error emitting shutdown lifecycle event: %O", err);
      }

      // 5. force-close whatever sockets remain (aborted SSE responses,
      //    keep-alive connections) so `server.close()` can complete.
      this.shutdownPhase = "closing remaining connections";
      if (this.server) {
        this.server.closeAllConnections();
      }
      if (serverClosed) {
        await serverClosed;
        logger.debug("Server closed gracefully");
      }

      // 6. close the cache manager's storage (drains the persistent
      //    Lakebase pool; no-op for in-memory storage) and flush telemetry.
      //    Runs after the lifecycle emit so subscribers can still read the
      //    cache. The two are independent (the flush never touches the
      //    cache), so they run concurrently — each bounded so a stuck pool
      //    drain or stalled OTLP export cannot eat the remaining budget.
      //    The flush runs inside the orchestrated shutdown instead of
      //    racing a standalone TelemetryManager signal handler against
      //    process.exit (see disownSignalHandlers in start()).
      this.shutdownPhase = "cache storage close + telemetry flush";
      const closeCacheStorage = async () => {
        let cache: CacheManager;
        try {
          cache = CacheManager.getInstanceSync();
        } catch {
          // Cache was never initialized — nothing to close.
          return;
        }
        try {
          await this.raceWithTimeout(
            cache.close(),
            ServerPlugin.PHASE_SHUTDOWN_TIMEOUT_MS,
            "cache storage close",
          );
        } catch (err) {
          logger.error("Error closing cache storage during shutdown: %O", err);
        }
      };
      const flushTelemetry = async () => {
        try {
          await this.raceWithTimeout(
            TelemetryManager.getInstance().shutdown(),
            ServerPlugin.PHASE_SHUTDOWN_TIMEOUT_MS,
            "telemetry flush",
          );
        } catch (err) {
          logger.error("Error flushing telemetry during shutdown: %O", err);
        }
      };
      await Promise.all([closeCacheStorage(), flushTelemetry()]);
    } catch (err) {
      logger.error("Error during graceful shutdown: %O", err);
      clearTimeout(forceExitTimer);
      process.exit(1);
      return;
    }

    clearTimeout(forceExitTimer);
    logger.info("Graceful shutdown complete");
    process.exit(0);
  }

  /**
   * Race `work` against a timeout. Rejects with a labeled error when the
   * timeout wins. A no-op rejection handler is attached to the work promise
   * before racing so a branch that rejects after the timeout already won
   * does not surface as an unhandledRejection.
   */
  private async raceWithTimeout<T>(
    work: Promise<T> | T,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const promise = Promise.resolve(work);
    promise.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Run a single plugin's `shutdown()` hook bounded by
   * {@link ServerPlugin.PLUGIN_SHUTDOWN_TIMEOUT_MS}. Errors and timeouts
   * are logged but never thrown so one misbehaving plugin cannot block
   * the rest of the shutdown sequence.
   */
  private async runPluginShutdown(plugin: BasePlugin): Promise<void> {
    try {
      await this.raceWithTimeout(
        plugin.shutdown?.(),
        ServerPlugin.PLUGIN_SHUTDOWN_TIMEOUT_MS,
        "shutdown()",
      );
    } catch (err) {
      logger.error("Error shutting down plugin %s: %O", plugin.name, err);
    }
  }

  /**
   * Returns the public exports for the server plugin.
   * Exposes server management methods.
   */
  exports() {
    const self = this;
    return {
      /** Extend the server with custom routes or middleware */
      extend(fn: (app: express.Application) => void) {
        self.extend(fn);
        return this;
      },
      /** Get the underlying HTTP server instance */
      getServer: this.getServer,
      /** Get the server configuration */
      getConfig: this.getConfig,
      /** @deprecated Server is now started automatically by createApp. */
      start() {
        throw new ServerError(
          "server.start() has been removed. Use the onPluginsReady callback instead:\n\n" +
            "  createApp({\n" +
            "    plugins: [server(), ...],\n" +
            "    onPluginsReady(appkit) {\n" +
            "      appkit.server.extend(...);\n" +
            "    },\n" +
            "  });\n\n" +
            "Run `npx appkit codemod on-plugins-ready --write` to auto-migrate.",
        );
      },
    };
  }
}

const EXCLUDED_PLUGINS: string[] = [ServerPlugin.manifest.name];

/** @internal Exported for unit tests. */
export function requestMetricsMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const startMs = Date.now();
  res.on("finish", () => {
    const reporter = TelemetryReporter.getInstance();
    if (!reporter) return;
    const routePath = (req.route as { path?: string } | undefined)?.path;
    if (!routePath) return;
    const baseUrl = req.baseUrl ?? "";
    const template = `${baseUrl}${routePath}`;
    reporter.recordRequest(
      req.method,
      template,
      res.statusCode,
      Date.now() - startMs,
    );
  });
  next();
}

/**
 * @internal
 */
export const server = toPlugin(ServerPlugin);
// Export manifest and types
