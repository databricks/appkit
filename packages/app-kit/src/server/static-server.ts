import fs from "node:fs";
import path from "node:path";
import express from "express";
import { getQueries } from "./utils";

/**
 * Static server for the App Kit.
 *
 * Serves pre-built static files in production mode. Handles SPA routing
 * by serving index.html for non-API routes and injects runtime configuration.
 *
 * @example
 * ```ts
 * const staticServer = new StaticServer(app, staticPath);
 * staticServer.setup();
 * ```
 */
export class StaticServer {
  private app: express.Application;
  private staticPath: string;

  constructor(app: express.Application, staticPath: string) {
    this.app = app;
    this.staticPath = staticPath;
  }

  /** Setup the static server. */
  setup() {
    this.app.use(
      express.static(this.staticPath, {
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
    const config = this.getRuntimeConfig();
    const configScript = `
        <script>
            window.__CONFIG__ = ${JSON.stringify(config)};
        </script>
    `;
    html = html.replace("<body>", `<body>${configScript}`);
    res.send(html);
  }

  private getRuntimeConfig() {
    const configFolder = path.join(process.cwd(), "config");
    return {
      appName: process.env.DATABRICKS_APP_NAME || "",
      queries: getQueries(configFolder),
    };
  }
}
