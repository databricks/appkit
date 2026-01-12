import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import type { PluginPhase } from "shared";
import { LoggerManager } from "@/observability";
import { createDebug } from "@/observability/debug";
import { Plugin, toPlugin } from "../plugin";
import { databricksClientMiddleware } from "../utils";
import { RemoteTunnelController } from "./remote-tunnel/remote-tunnel-controller";
import { StaticServer } from "./static-server";
import type { ServerConfig } from "./types";
import { getRoutes, type PluginEndpoints } from "./utils";
import { ViteDevServer } from "./vite-dev-server";

dotenv.config({ path: path.resolve(process.cwd(), "./.env") });

/**
 * Server plugin for the AppKit.
 *
 * This plugin is responsible for starting the server and serving the static files.
 * It also handles the remote tunneling for development purposes.
 *
 * @example
 * ```ts
 * createApp({
 *   plugins: [server(), telemetryExamples(), analytics({})],
 * });
 * ```
 *
 */
export class ServerPlugin extends Plugin {
  public static DEFAULT_CONFIG = {
    autoStart: true,
    host: process.env.FLASK_RUN_HOST || "0.0.0.0",
    port: Number(process.env.DATABRICKS_APP_PORT) || 8000,
  };

  public name = "server" as const;
  public envVars: string[] = [];
  private serverApplication: express.Application;
  private server: HTTPServer | null;
  private viteDevServer?: ViteDevServer;
  private remoteTunnelController?: RemoteTunnelController;
  protected declare config: ServerConfig;
  private serverExtensions: ((app: express.Application) => void)[] = [];
  static phase: PluginPhase = "deferred";
  static debug = createDebug("server");

  constructor(config: ServerConfig) {
    super(config);
    this.config = config;
    this.serverApplication = express();
    this.server = null;
    this.serverExtensions = [];
  }

  /** Setup the server plugin. */
  async setup() {
    if (this.shouldAutoStart()) {
      await this.start();
    }
  }

  /** Get the server configuration. */
  getConfig() {
    const { plugins: _plugins, ...config } = this.config;

    return config;
  }

  /** Check if the server should auto start. */
  shouldAutoStart() {
    return this.config.autoStart;
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
    this.serverApplication.use(LoggerManager.getMiddleware());
    this.serverApplication.use(express.json());

    const endpoints = await this.extendRoutes();

    for (const extension of this.serverExtensions) {
      extension(this.serverApplication);
    }

    // register remote tunnel controller (before static/vite)
    this.remoteTunnelController = new RemoteTunnelController(
      this.devFileReader,
    );
    this.serverApplication.use(this.remoteTunnelController.middleware);

    await this.setupFrontend(endpoints);

    const server = this.serverApplication.listen(
      this.config.port ?? ServerPlugin.DEFAULT_CONFIG.port,
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
      ServerPlugin.debug("Registered routes", { routes: allRoutes });
    }
    return this.serverApplication;
  }

  /**
   * Get the low level node.js http server instance.
   *
   * Only use this method if you need to access the server instance for advanced usage like a custom websocket server, etc.
   *
   * @throws {Error} If the server is not started or autoStart is true.
   * @returns {HTTPServer} The server instance.
   */
  getServer(): HTTPServer {
    if (this.shouldAutoStart()) {
      throw new Error("Cannot get server when autoStart is true.");
    }

    if (!this.server) {
      throw new Error(
        "Server not started. Please start the server first by calling the start() method.",
      );
    }

    return this.server;
  }

  /**
   * Extend the server with custom routes or middleware.
   *
   * @param fn - A function that receives the express application.
   * @returns The server plugin instance for chaining.
   * @throws {Error} If autoStart is true.
   */
  extend(fn: (app: express.Application) => void) {
    if (this.shouldAutoStart()) {
      throw new Error("Cannot extend server when autoStart is true.");
    }

    this.serverExtensions.push(fn);
    return this;
  }

  /**
   * Setup the routes with the plugins.
   *
   * This method goes through all the plugins and injects the routes into the server application.
   * Returns a map of plugin names to their registered named endpoints.
   */
  private async extendRoutes(): Promise<PluginEndpoints> {
    const endpoints: PluginEndpoints = {};

    if (!this.config.plugins) return endpoints;

    this.serverApplication.get("/health", (_, res) => {
      res.status(200).json({ status: "ok" });
    });
    this.registerEndpoint("health", "/health");

    for (const plugin of Object.values(this.config.plugins)) {
      if (EXCLUDED_PLUGINS.includes(plugin.name)) continue;

      if (plugin?.injectRoutes && typeof plugin.injectRoutes === "function") {
        const router = express.Router();

        // add databricks client middleware to the router if the plugin needs the request context
        if (plugin.requiresDatabricksClient)
          router.use(await databricksClientMiddleware());

        plugin.injectRoutes(router);

        const basePath = `/api/${plugin.name}`;
        this.serverApplication.use(basePath, router);

        // Collect named endpoints from the plugin
        endpoints[plugin.name] = plugin.getEndpoints();
      }
    }

    return endpoints;
  }

  /**
   * Setup frontend serving based on environment:
   * - If staticPath is explicitly provided: use static server
   * - Dev mode (no staticPath): Vite for HMR
   * - Production (no staticPath): Static files auto-detected
   */
  private async setupFrontend(endpoints: PluginEndpoints) {
    const isDev = process.env.NODE_ENV === "development";
    const hasExplicitStaticPath = this.config.staticPath !== undefined;

    // explict static path provided
    if (hasExplicitStaticPath) {
      const staticServer = new StaticServer(
        this.serverApplication,
        this.config.staticPath as string,
        endpoints,
      );
      staticServer.setup();
      return;
    }

    // auto-detection based on environment
    if (isDev) {
      this.viteDevServer = new ViteDevServer(this.serverApplication, endpoints);
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
        const msg = `Static files: serving from ${fullPath}`;
        ServerPlugin.debug(msg);
        return fullPath;
      }
    }
    return undefined;
  }

  private logStartupInfo() {
    const isDev = process.env.NODE_ENV === "development";
    const hasExplicitStaticPath = this.config.staticPath !== undefined;
    const port = this.config.port ?? ServerPlugin.DEFAULT_CONFIG.port;
    const host = this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host;

    ServerPlugin.debug("Server started", {
      url: `http://${host}:${port}`,
      mode: hasExplicitStaticPath
        ? "static"
        : isDev
          ? "development"
          : "production",
      staticPath: this.config.staticPath,
      remoteTunnel: {
        allowed: this.remoteTunnelController?.isAllowedByEnv(),
        active: this.remoteTunnelController?.isActive(),
      },
    });

    if (!this.remoteTunnelController) {
      ServerPlugin.debug(
        "Remote tunnel: disabled (controller not initialized)",
      );
    } else {
      const allowed = !!this.remoteTunnelController.isAllowedByEnv();
      const active = !!this.remoteTunnelController.isActive();
      ServerPlugin.debug(
        `Remote tunnel: ${allowed ? "allowed" : "disallowed"}; ${
          active ? "active" : "inactive"
        }`,
      );
    }
  }

  private async _gracefulShutdown() {
    ServerPlugin.debug("Starting graceful shutdown");

    if (this.viteDevServer) {
      await this.viteDevServer.close();
    }

    if (this.remoteTunnelController) {
      this.remoteTunnelController.cleanup();
    }

    // 1. abort active operations from plugins
    if (this.config.plugins) {
      for (const plugin of Object.values(this.config.plugins)) {
        if (plugin.abortActiveOperations) {
          try {
            plugin.abortActiveOperations();
          } catch (err) {
            console.error(
              `Error aborting operations for plugin ${plugin.name}:`,
              err,
            );
          }
        }
      }
    }

    // 2. close the server
    if (this.server) {
      this.server.close(() => {
        ServerPlugin.debug("Server closed gracefully");
        process.exit(0);
      });

      // 3. timeout to force shutdown after 15 seconds
      setTimeout(() => {
        ServerPlugin.debug("Force shutdown after timeout");
        process.exit(1);
      }, 15000);
    } else {
      process.exit(0);
    }
  }
}

const EXCLUDED_PLUGINS = [ServerPlugin.name];

export const server = toPlugin<typeof ServerPlugin, ServerConfig, "server">(
  ServerPlugin,
  "server",
);
