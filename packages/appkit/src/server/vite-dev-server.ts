import fs from "node:fs";
import path from "node:path";
import type express from "express";
import type { ViteDevServer as ViteDevServerType } from "vite";
import { mergeConfigDedup } from "@/utils";
import { ServerError } from "../observability/errors";
import { BaseServer } from "./base-server";
import type { PluginEndpoints } from "./utils";
import { appKitTypesPlugin } from "../type-generator/vite-plugin";

/**
 * Vite dev server for the AppKit.
 *
 * This class is responsible for serving the Vite dev server for the development server.
 * It also handles the index.html file for the development server.
 *
 * @example
 * ```ts
 * const viteDevServer = new ViteDevServer(app, endpoints);
 * await viteDevServer.setup();
 * ```
 */
export class ViteDevServer extends BaseServer {
  private vite: ViteDevServerType | null;

  constructor(app: express.Application, endpoints: PluginEndpoints = {}) {
    super(app, endpoints);
    this.vite = null;
  }

  /**
   * Setup the Vite dev server.
   *
   * This method sets up the Vite dev server and the index.html file for the development server.
   *
   * @returns
   */
  async setup() {
    const {
      createServer: createViteServer,
      loadConfigFromFile,
      mergeConfig,
    } = await import("vite");
    const react = await import("@vitejs/plugin-react");

    const clientRoot = this.findClientRoot();

    const loadedConfig = await loadConfigFromFile(
      {
        mode: "development",
        command: "serve",
      },
      undefined,
      clientRoot,
    );

    const userConfig = loadedConfig?.config ?? {};
    const coreConfig = {
      configFile: false,
      root: clientRoot,
      server: {
        middlewareMode: true,
        watch: {
          useFsEvents: true,
          ignored: ["**/node_modules/**", "!**/node_modules/@databricks/**"],
        },
      },
      plugins: [react.default(), appKitTypesPlugin()],
      appType: "custom",
    };

    const mergedConfigs = mergeConfigDedup(userConfig, coreConfig, mergeConfig);
    this.vite = await createViteServer(mergedConfigs);

    this.app.use(this.vite.middlewares);

    this.app.use("*", async (req, res, next) => {
      if (
        req.originalUrl.startsWith("/api") ||
        req.originalUrl.startsWith("/query")
      ) {
        return next();
      }
      const vite = this.vite;
      this.validateVite(vite);

      try {
        const indexPath = path.resolve(clientRoot, "index.html");
        let html = fs.readFileSync(indexPath, "utf-8");
        html = html.replace("<body>", `<body>${this.getConfigScript()}`);
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  }

  /** Close the Vite dev server. */
  async close() {
    await this.vite?.close();
  }

  /** Find the client root. */
  private findClientRoot(): string {
    const cwd = process.cwd();
    const candidates = ["client", "src", "app", "frontend", "."];

    for (const dir of candidates) {
      const fullPath = path.resolve(cwd, dir);
      const hasViteConfig =
        fs.existsSync(path.join(fullPath, "vite.config.ts")) ||
        fs.existsSync(path.join(fullPath, "vite.config.js"));
      const hasIndexHtml = fs.existsSync(path.join(fullPath, "index.html"));

      if (hasViteConfig && hasIndexHtml) {
        console.log(`Vite dev server: using client root ${fullPath}`);
        return fullPath;
      }
    }

    throw ServerError.clientDirectoryNotFound(candidates);
  }

  // type assertion to ensure vite is not null
  private validateVite(
    vite: ViteDevServerType | null,
  ): asserts vite is ViteDevServerType {
    if (!vite) {
      throw ServerError.viteNotInitialized();
    }
  }
}
