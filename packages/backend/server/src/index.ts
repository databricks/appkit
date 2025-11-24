import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import { Plugin, toPlugin } from "@databricks-apps/plugin";
import type {
  BasePluginConfig,
  IAuthManager,
  PluginPhase,
} from "@databricks-apps/types";
import express from "express";
import { getQueries, getRoutes } from "./utils";
import { DevModeManager } from "./dev-mode";
import { isRemoteServerEnabled } from "@databricks-apps/utils";

export interface ServerConfig extends BasePluginConfig {
  port?: number;
  plugins?: Record<string, Plugin>;
  staticPath?: string;
  autoStart?: boolean;
  host?: string;
  watch?: boolean;
}

export class ServerPlugin extends Plugin {
  public name = "server" as const;
  public envVars = ["DATABRICKS_APP_PORT", "FLASK_RUN_HOST"];
  public static DEFAULT_CONFIG = {
    autoStart: true,
    host: process.env.FLASK_RUN_HOST || "0.0.0.0",
    port: Number(process.env.DATABRICKS_APP_PORT) || 8000,
    watch: process.env.NODE_ENV === "development",
  };
  private serverApplication: express.Application;
  private server: HTTPServer | null;
  private devModeManager?: DevModeManager;
  protected declare config: ServerConfig;
  static phase: PluginPhase = "deferred";

  constructor(config: ServerConfig, auth: IAuthManager) {
    super(config, auth);
    this.config = config;
    this.serverApplication = express();
    this.server = null;
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
    return this.config.autoStart ?? ServerPlugin.DEFAULT_CONFIG.autoStart;
  }

  isRemoteServingEnabled() {
    return isRemoteServerEnabled();
  }

  async start(): Promise<express.Application> {
    this.serverApplication.use(express.json());

    this.extendRoutes();

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
      this.config.port || ServerPlugin.DEFAULT_CONFIG.port,
      this.config.host || ServerPlugin.DEFAULT_CONFIG.host,
      () => {
        console.log(
          `Server is running on port ${
            this.config.port || ServerPlugin.DEFAULT_CONFIG.port
          }`,
        );
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

  extend(fn: (app: express.Application) => void) {
    if (this.shouldAutoStart()) {
      throw new Error("Cannot extend server when autoStart is true.");
    }

    fn(this.serverApplication);

    return this;
  }

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
