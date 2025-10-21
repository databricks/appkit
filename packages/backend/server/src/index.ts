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

  async start(): Promise<express.Application> {
    this.serverApplication.use(express.json());

    this.extendRoutes();

    if (this.config.watch) {
      await this._setupWatching();
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

    process.on("SIGTERM", () => this._gracefulShutdown());
    process.on("SIGINT", () => this._gracefulShutdown());

    if (process.env.NODE_ENV === "development") {
      // TODO: improve this
      const allRoutes = getRoutes(this.serverApplication._router.stack);
      console.log(allRoutes);
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

    for (const plugin of Object.values(this.config.plugins)) {
      if (EXCLUDED_PLUGINS.includes(plugin.name)) continue;

      if (plugin?.injectRoutes && typeof plugin.injectRoutes === "function") {
        const router = express.Router();

        plugin.injectRoutes(router);

        this.serverApplication.use(`/api/${plugin.name}`, router);
      }
    }
  }

  private async _setupWatching() {
    if (!this.config.watch) return;

    if (process.env.NODE_ENV !== "production") {
      const { createServer: createViteServer } = require("vite");
      const { default: react } = require("@vitejs/plugin-react");

      const clientRoot = path.resolve(process.cwd(), "client");

      const config = {
        configFile: false,
        root: clientRoot,
        server: { middlewareMode: true, watch: false },
        plugins: [react()],
      };

      const vite = await createViteServer(config);

      this.serverApplication.use(vite.middlewares);

      this.serverApplication.use("*", async (req, res, next) => {
        try {
          if (!req.path.startsWith("/api")) {
            const url = req.originalUrl;
            const indexHtmlPath = path.resolve(clientRoot, "index.html");
            let template = fs.readFileSync(indexHtmlPath, "utf-8");

            template = await vite.transformIndexHtml(url, template);

            res.status(200).set({ "Content-Type": "text/html" }).end(template);
          } else {
            next();
          }
        } catch (e) {
          vite.ssrFixStacktrace(e as Error);
          next(e);
        }
      });
    }
  }

  private _setupStaticServing() {
    if (!this.config.staticPath) return;

    this.serverApplication.get("/", (_, res) => {
      this._renderFE(res);
    });

    this.serverApplication.use(express.static(this.config.staticPath));

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

    res.sendFile(indexPath, (err) => {
      if (err)
        res
          .status(404)
          .json({ error: "Frontend not found", details: err.message });
    });
  }

  private _gracefulShutdown() {
    console.log("Starting graceful shutdown...");

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

function getRoutes(stack: unknown[], basePath = "") {
  const routes: Array<{ path: string; methods: string[] }> = [];

  stack.forEach((layer: any) => {
    if (layer.route) {
      // normal route
      const path = basePath + layer.route.path;
      const methods = Object.keys(layer.route.methods).map((m) =>
        m.toUpperCase(),
      );
      routes.push({ path, methods });
    } else if (layer.name === "router" && layer.handle.stack) {
      // nested router
      const nestedBase =
        basePath +
          layer.regexp.source
            .replace("^\\", "")
            .replace("\\/?(?=\\/|$)", "")
            .replace(/\\\//g, "/") // convert escaped slashes
            .replace(/\$$/, "") || "";
      routes.push(...getRoutes(layer.handle.stack, nestedBase));
    }
  });

  return routes;
}
