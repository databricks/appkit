import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import type { PluginPhase } from "shared";
import { Plugin, toPlugin } from "../plugin";
import { instrumentations } from "../telemetry";
import { databricksClientMiddleware, isRemoteServerEnabled } from "../utils";
import { RemoteTunnelManager } from "./remote-tunnel-manager";
import { StaticServer } from "./static-server";
import type { ServerConfig } from "./types";
import { getRoutes } from "./utils";
import { ViteDevServer } from "./vite-dev-server";

dotenv.config({ path: path.resolve(process.cwd(), "./server/.env") });

/**
 * Server plugin for the App Kit.
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
  public envVars = ["DATABRICKS_APP_PORT", "FLASK_RUN_HOST"];
  private serverApplication: express.Application;
  private server: HTTPServer | null;
  private viteDevServer?: ViteDevServer;
  private remoteTunnelManager?: RemoteTunnelManager;
  protected declare config: ServerConfig;
  private serverExtensions: ((app: express.Application) => void)[] = [];
  static phase: PluginPhase = "deferred";

  constructor(config: ServerConfig) {
    super(config);
    this.config = config;
    this.serverApplication = express();
    this.server = null;
    this.serverExtensions = [];
    this.telemetry.registerInstrumentations([
      instrumentations.http,
      instrumentations.express,
    ]);
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

  /** Check if the remote serving is enabled. */
  isRemoteServingEnabled() {
    return isRemoteServerEnabled();
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
    this.serverApplication.use(express.json());
    this.serverApplication.use(await databricksClientMiddleware());

    this.extendRoutes();

    for (const extension of this.serverExtensions) {
      extension(this.serverApplication);
    }

    await this.setupFrontend();

    const server = this.serverApplication.listen(
      this.config.port ?? ServerPlugin.DEFAULT_CONFIG.port,
      this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host,
      () => this.logStartupInfo(),
    );

    this.server = server;

    if (this.isRemoteServingEnabled()) {
      this.setupRemoteTunnels();
    }

    process.on("SIGTERM", () => this._gracefulShutdown());
    process.on("SIGINT", () => this._gracefulShutdown());

    if (process.env.NODE_ENV === "development") {
      const allRoutes = getRoutes(this.serverApplication._router.stack);
      console.dir(allRoutes, { depth: null });
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
   * Setup the routes with the plugins.
   *
   * This method goes through all the plugins and injects the routes into the server application.
   */
  private extendRoutes() {
    if (!this.config.plugins) return;

    this.serverApplication.get("/health", (_, res) => {
      res.status(200).json({ status: "ok" });
    });

    for (const plugin of Object.values(this.config.plugins)) {
      if (EXCLUDED_PLUGINS.includes(plugin.name)) continue;

      if (plugin?.injectRoutes && typeof plugin.injectRoutes === "function") {
        const router = express.Router();

        plugin.injectRoutes(router);

        this.serverApplication.use(`/api/${plugin.name}`, router);
      }
    }
  }

  /**
   * Setup the frontend.
   *
   * This method sets up the frontend using Vite for development and static files for production.
   */
  private async setupFrontend() {
    const isDev = process.env.NODE_ENV === "development";
    if (isDev) {
      this.viteDevServer = new ViteDevServer(this.serverApplication);
      await this.viteDevServer.setup();
    } else {
      const staticPath = this.config.staticPath ?? this.findStaticPath();
      if (staticPath) {
        const staticServer = new StaticServer(
          this.serverApplication,
          staticPath,
        );
        staticServer.setup();
      }
    }
  }

  /**
   * Setup the remote tunnels.
   *
   * This method sets up the remote tunnels for the development server.
   */
  private setupRemoteTunnels() {
    if (!this.server) return;

    this.remoteTunnelManager = new RemoteTunnelManager(this.devFileReader);
    this.remoteTunnelManager.setServer(this.server);
    this.remoteTunnelManager.setup(this.serverApplication);
    this.remoteTunnelManager.setupWebSocket();
  }

  private findStaticPath() {
    const staticPaths = ["dist", "client/dist", "build", "public", "out"];
    const cwd = process.cwd();
    for (const p of staticPaths) {
      const fullPath = path.resolve(cwd, p);
      if (fs.existsSync(path.resolve(fullPath, "index.html"))) {
        console.log(`Static files: serving from ${fullPath}`);
        return fullPath;
      }
    }
    return undefined;
  }

  private logStartupInfo() {
    const isDev = process.env.NODE_ENV === "development";
    const port = this.config.port ?? ServerPlugin.DEFAULT_CONFIG.port;
    const host = this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host;

    console.log(`Server running on http://${host}:${port}`);
    console.log(
      `Mode: ${isDev ? "development (Vite HMR)" : "production (static)"}`,
    );

    if (this.isRemoteServingEnabled()) {
      console.log("Remote tunnel support: enabled");
    }
  }

  private async _gracefulShutdown() {
    console.log("Starting graceful shutdown...");

    if (this.viteDevServer) {
      await this.viteDevServer.close();
    }

    if (this.remoteTunnelManager) {
      this.remoteTunnelManager.cleanup();
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
        console.log("Server closed gracefully");
        process.exit(0);
      });

      // 3. timeout to force shutdown after 15 seconds
      setTimeout(() => {
        console.log("Force shutdown after timeout");
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
