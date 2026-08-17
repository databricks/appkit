import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";

import dotenv from "dotenv";
import express from "express";
import getPort, { portNumbers } from "get-port";
import type { PluginClientConfigs, PluginPhase } from "shared";
import { camelToKebab } from "shared";

import { AppKitError, ServerError } from "../../errors";
import { TelemetryReporter } from "../../internal-telemetry";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { instrumentations } from "../../telemetry";
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
   * Budget for awaiting `server.close()` during shutdown. Bounded because
   * `closeAllConnections()` runs immediately before the await, so the close
   * is expected to resolve promptly; the core lifecycle manager's overall
   * force-exit timer is the ultimate backstop if it does not.
   */
  private static readonly SERVER_CLOSE_TIMEOUT_MS = 2_000;

  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"server">;
  private serverApplication: express.Application;
  private server: HTTPServer | null;
  private viteDevServer?: ViteDevServer;
  private remoteTunnelController?: RemoteTunnelController;
  /** Bound listen port after optional dev-time resolution. */
  private resolvedListenPort?: number;
  declare protected config: ServerConfig;
  private serverExtensions: ((app: express.Application) => void)[] = [];
  private rawBodyPaths: Set<string> = new Set();
  /**
   * Resolves when `server.close()` completes. Created in
   * {@link abortActiveOperations} (which initiates the close) and awaited in
   * {@link closeRemainingConnections} after other plugins have drained.
   */
  private serverClosed?: Promise<void>;
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

    // Terminal error handler — registered after all routes, extensions, and
    // frontend middleware so that errors forwarded via next(err) from any of
    // them (e.g. async handler rejections forwarded by Plugin.route()) are
    // turned into JSON error responses instead of hanging the request.
    this.serverApplication.use(errorHandlerMiddleware);

    const listenPort = await this.resolveListenPort();

    const server = this.serverApplication.listen(
      listenPort,
      this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host,
      () => this.logStartupInfo(),
    );

    this.server = server;

    // attach server to remote tunnel controller
    this.remoteTunnelController.setServer(server);

    // Graceful shutdown is orchestrated by the core LifecycleManager, which
    // owns the process signal handlers. This plugin only contributes its
    // HTTP concerns: it aborts/initiates the socket close in
    // abortActiveOperations(), drains dev servers in shutdown(), and force-
    // closes remaining sockets in the "shutdown" lifecycle hook below (which
    // fires after every plugin's shutdown() has run).
    this.context?.onLifecycle("shutdown", () =>
      this.closeRemainingConnections(),
    );

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
   * Note: async handlers registered directly on the app must handle their own
   * rejections — Express 4 does not forward rejected promises to the error
   * middleware. Errors passed explicitly to `next(err)` are formatted by the
   * terminal error middleware.
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

        const basePath = `/api/${camelToKebab(plugin.name)}`;
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

  /**
   * Cancel in-flight work and begin closing the HTTP server.
   *
   * Runs in the first phase of the core LifecycleManager's graceful shutdown,
   * before any plugin `shutdown()` hook. In addition to the base behavior
   * (aborting SSE streams), it stops the server accepting new connections and
   * drops idle keep-alive sockets — without `closeIdleConnections()`, a
   * connected browser would pin `server.close()` open until the force-exit
   * timer fires. The close is only *initiated* here; the returned promise is
   * awaited later in {@link closeRemainingConnections} so peer plugins can
   * still drain in-flight requests through the server first.
   */
  abortActiveOperations(): void {
    super.abortActiveOperations();

    if (this.server) {
      const server = this.server;
      this.serverClosed = new Promise((resolve) => {
        server.close(() => resolve());
      });
      server.closeIdleConnections();
    }
  }

  /**
   * Drain the dev-only servers as this plugin's `shutdown()` hook.
   *
   * Runs concurrently with the other plugins' hooks during graceful shutdown.
   * These are no-ops in production (neither is created), so this hook is
   * effectively dev-only.
   */
  async shutdown(): Promise<void> {
    if (this.viteDevServer) {
      await this.viteDevServer.close();
    }
    if (this.remoteTunnelController) {
      this.remoteTunnelController.cleanup();
    }
  }

  /**
   * Force-close whatever sockets remain and await the server close.
   *
   * Registered on the `"shutdown"` lifecycle event in {@link start}, so it
   * fires after every plugin's `shutdown()` hook has run — meaning any
   * in-flight request a peer plugin was draining has already completed.
   * `closeAllConnections()` destroys the leftover sockets (aborted SSE
   * responses, keep-alive connections) synchronously so the pending
   * `server.close()` can complete; the await is bounded because the close is
   * expected to resolve promptly once the sockets are gone.
   */
  private async closeRemainingConnections(): Promise<void> {
    if (this.server) {
      this.server.closeAllConnections();
    }
    if (!this.serverClosed) return;

    await Promise.race([
      this.serverClosed,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ServerPlugin.SERVER_CLOSE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    logger.debug("Server closed gracefully");
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
 * Narrow an unknown thrown value to an Error that carries a numeric
 * `statusCode` property in the HTTP error range (e.g. `ApiError` from
 * `@databricks/sdk-experimental`).
 */
function hasHttpStatusCode(
  error: unknown,
): error is Error & { statusCode: number } {
  if (!(error instanceof Error) || !("statusCode" in error)) return false;
  const statusCode = error.statusCode;
  return (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
  );
}

/**
 * Terminal Express error-handling middleware.
 *
 * Converts errors forwarded via `next(err)` (including async handler
 * rejections forwarded by `Plugin.route()`) into JSON error responses,
 * following the same status/message conventions as `Plugin.execute()`:
 * - errors carrying an HTTP `statusCode` (including `AppKitError`) → that
 *   status; 5xx messages are masked in production to avoid leaking internals
 * - anything else → 500 with a generic message in production
 *
 * 4xx errors are expected client errors (e.g. missing auth headers) and are
 * logged at `warn` with just the message; 5xx/unknown errors are logged at
 * `error` with the full error.
 *
 * @internal Exported for unit tests.
 */
export function errorHandlerMiddleware(
  err: unknown,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const httpError =
    err instanceof AppKitError || hasHttpStatusCode(err) ? err : null;
  const statusCode = httpError ? httpError.statusCode : 500;
  const isClientError = statusCode < 500;

  if (isClientError) {
    logger.warn(
      "Request failed for %s %s with status %d: %s",
      req.method,
      req.originalUrl,
      statusCode,
      err instanceof Error ? err.message : String(err),
    );
  } else {
    logger.error(
      "Unhandled error for %s %s: %O",
      req.method,
      req.originalUrl,
      // toJSON() redacts sensitive context fields; %O on a raw AppKitError
      // would enumerate them unredacted.
      err instanceof AppKitError ? err.toJSON() : err,
    );
  }

  if (res.headersSent) {
    next(err);
    return;
  }

  const isDev = process.env.NODE_ENV !== "production";
  const message = err instanceof Error ? err.message : "Server error";

  res.status(statusCode).json({
    error: isDev || isClientError ? message : "Server error",
  });
}

/**
 * @internal
 */
export const server = toPlugin(ServerPlugin);
// Export manifest and types
