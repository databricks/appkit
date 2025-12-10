import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import type { PluginPhase } from "shared";
import { Plugin, toPlugin } from "../plugin";
import { instrumentations } from "../telemetry";
import { databricksClientMiddleware, isRemoteServerEnabled } from "../utils";
import { DevModeManager } from "./dev-mode";
import type { ServerConfig } from "./types";
import { getQueries, getRoutes } from "./utils";

dotenv.config({ path: path.resolve(process.cwd(), "./server/.env") });

export class ServerPlugin extends Plugin {
  public static DEFAULT_CONFIG = {
    autoStart: true,
    staticPath: path.resolve(process.cwd(), "client", "dist"),
    host: process.env.FLASK_RUN_HOST || "0.0.0.0",
    port: Number(process.env.DATABRICKS_APP_PORT) || 8000,
    watch: process.env.NODE_ENV === "development",
  };

  public name = "server" as const;
  public envVars: string[] = [];
  private serverApplication: express.Application;
  private server: HTTPServer | null;
  private devModeManager?: DevModeManager;
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

  async setup() {
    if (this.shouldAutoStart()) {
      await this.start();
    }
  }

  getConfig() {
    const { plugins: _plugins, ...config } = this.config;

    return config;
  }

  shouldAutoStart() {
    return this.config.autoStart;
  }

  isRemoteServingEnabled() {
    return isRemoteServerEnabled();
  }

  async start(): Promise<express.Application> {
    this.serverApplication.use(express.json());

    await this.extendRoutes();

    for (const extension of this.serverExtensions) {
      extension(this.serverApplication);
    }

    const isRemoteDevModeEnabled = this.isRemoteServingEnabled();
    if (isRemoteDevModeEnabled) {
      this.devModeManager = new DevModeManager(this.devFileReader);

      if (this.config.watch) {
        await this.devModeManager.setupViteWatching(this.serverApplication);
      }

      this.serverApplication.use(this.devModeManager.devModeMiddleware());
      this.serverApplication.use(
        DevModeManager.ASSETS_MIDDLEWARE_PATHS,
        this.devModeManager.assetMiddleware(),
      );
    }

    if (this.config.staticPath && !this.config.watch) {
      this._setupStaticServing();
    }

    const server = this.serverApplication.listen(
      this.config.port ?? ServerPlugin.DEFAULT_CONFIG.port,
      this.config.host ?? ServerPlugin.DEFAULT_CONFIG.host,
      () => {
        console.log(`Server is running on port ${this.config.port}`);
        if (this.config.staticPath && !this.config.watch) {
          console.log(`Serving static files from: ${this.config.staticPath}`);
        }
        if (this.config.watch) {
          console.log("Vite is watching for changes...");
        }
      },
    );

    this.server = server;

    if (isRemoteDevModeEnabled && this.devModeManager) {
      this.devModeManager.setServer(server);
      this.devModeManager.setupWebSocket();
    }

    process.on("SIGTERM", () => this._gracefulShutdown());
    process.on("SIGINT", () => this._gracefulShutdown());

    if (process.env.NODE_ENV === "development") {
      // TODO: improve this
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

  extend(fn: (app: express.Application) => void) {
    if (this.shouldAutoStart()) {
      throw new Error("Cannot extend server when autoStart is true.");
    }

    this.serverExtensions.push(fn);
    return this;
  }

  private async extendRoutes() {
    if (!this.config.plugins) return;

    this.serverApplication.get("/health", (_, res) => {
      res.status(200).json({ status: "ok" });
    });

    for (const plugin of Object.values(this.config.plugins)) {
      if (EXCLUDED_PLUGINS.includes(plugin.name)) continue;

      if (plugin?.injectRoutes && typeof plugin.injectRoutes === "function") {
        const router = express.Router();

        // add databricks client middleware to the router if the plugin needs the request context
        if (plugin.requiresDatabricksClient)
          router.use(await databricksClientMiddleware());

        plugin.injectRoutes(router);

        this.serverApplication.use(`/api/${plugin.name}`, router);
      }
    }
  }

  private _setupStaticServing() {
    if (!this.config.staticPath) return;

    this.serverApplication.use(
      express.static(this.config.staticPath, {
        index: false,
      }),
    );

    this.serverApplication.get("*", (req, res) => {
      if (!req.path.startsWith("/api") && !req.path.startsWith("/query")) {
        this._renderFE(res);
      }
    });
  }

  private _renderFE(res: express.Response) {
    if (!this.config.staticPath) {
      return res.status(500).json({ error: "No static path configured" });
    }

    const indexPath = path.join(this.config.staticPath, "index.html");
    const configObject = this._configInjection();
    const configScript = `
      <script>
        window.__CONFIG__ = ${JSON.stringify(configObject)};
      </script>
    `;
    let html = fs.readFileSync(indexPath, "utf-8");

    html = html.replace("<body>", `<body>${configScript}`);

    res.send(html);
  }

  private _configInjection() {
    const configFolder = path.join(process.cwd(), "config");

    const configObject = {
      appName: process.env.DATABRICKS_APP_NAME || "",
      queries: getQueries(configFolder),
    };

    return configObject;
  }

  private _gracefulShutdown() {
    console.log("Starting graceful shutdown...");

    if (this.devModeManager) {
      this.devModeManager.cleanup();
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
