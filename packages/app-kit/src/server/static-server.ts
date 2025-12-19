import fs from "node:fs";
import path from "node:path";
import type express from "express";
import expressStatic from "express";
import { BaseServer } from "./base-server";
import type { PluginEndpoints } from "./utils";

/**
 * Static server for the App Kit.
 *
 * Serves pre-built static files in production mode. Handles SPA routing
 * by serving index.html for non-API routes and injects runtime configuration.
 *
 * @example
 * ```ts
 * const staticServer = new StaticServer(app, staticPath, endpoints);
 * staticServer.setup();
 * ```
 */
export class StaticServer extends BaseServer {
  private staticPath: string;

  constructor(
    app: express.Application,
    staticPath: string,
    endpoints: PluginEndpoints = {},
  ) {
    super(app, endpoints);
    this.staticPath = staticPath;
  }

  /** Setup the static server. */
  setup() {
    this.app.use(
      expressStatic.static(this.staticPath, {
        index: false,
      }),
    );

    this.app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/query")) {
        return next();
      }
      this.serveIndex(res);
    });
  }

  /** Serve the index.html file. */
  private serveIndex(res: express.Response) {
    const indexPath = path.join(this.staticPath, "index.html");

    if (!fs.existsSync(indexPath)) {
      res.status(404).send("index.html not found");
      return;
    }

    let html = fs.readFileSync(indexPath, "utf-8");
    html = html.replace("<body>", `<body>${this.getConfigScript()}`);
    res.send(html);
  }
}
