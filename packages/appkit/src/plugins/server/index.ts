import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import getPort, { portNumbers } from "get-port";
import type { PluginClientConfigs, PluginPhase } from "shared";
import { ServerError } from "../../errors";
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

    process.on("SIGTERM", () => this._gracefulShutdown());
    process.on("SIGINT", () => this._gracefulShutdown());

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
    logger.info("Starting graceful shutdown...");

    if (this.viteDevServer) {
      await this.viteDevServer.close();
    }

    if (this.remoteTunnelController) {
      this.remoteTunnelController.cleanup();
    }

    TelemetryReporter.getInstance()?.stop();

    // 1. abort active operations from plugins
    const shutdownPlugins = this.context?.getPlugins();
    if (shutdownPlugins) {
      for (const plugin of shutdownPlugins.values()) {
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
    }

    // 2. close the server
    if (this.server) {
      this.server.close(() => {
        logger.debug("Server closed gracefully");
        process.exit(0);
      });

      // 3. timeout to force shutdown after 15 seconds
      setTimeout(() => {
        logger.debug("Force shutdown after timeout");
        process.exit(1);
      }, 15000);
    } else {
      process.exit(0);
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
