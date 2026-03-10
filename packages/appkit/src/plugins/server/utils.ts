import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import pc from "picocolors";

export function parseCookies(
  req: http.IncomingMessage,
): Record<string, string> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};

  // Fast path: if there's no semicolon, there's only one cookie
  const semicolonIndex = cookieHeader.indexOf(";");
  if (semicolonIndex === -1) {
    const eqIndex = cookieHeader.indexOf("=");
    if (eqIndex === -1) return {};
    return {
      [cookieHeader.slice(0, eqIndex).trim()]: cookieHeader.slice(eqIndex + 1),
    };
  }

  // Multiple cookies: parse them all
  const cookies: Record<string, string> = {};
  const parts = cookieHeader.split(";");
  for (let i = 0; i < parts.length; i++) {
    const eqIndex = parts[i].indexOf("=");
    if (eqIndex !== -1) {
      const key = parts[i].slice(0, eqIndex).trim();
      const value = parts[i].slice(eqIndex + 1);
      cookies[key] = value;
    }
  }
  return cookies;
}

export function generateTunnelIdFromEmail(email?: string): string | undefined {
  if (!email) return undefined;

  const tunnelId = crypto
    .createHash("sha256")
    .update(email)
    .digest("base64url")
    .slice(0, 8);

  return tunnelId;
}

export function getRoutes(stack: unknown[], basePath = "") {
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

const METHOD_COLORS: Record<string, (s: string) => string> = {
  GET: pc.green,
  POST: pc.blue,
  PUT: pc.yellow,
  PATCH: pc.yellow,
  DELETE: pc.red,
  HEAD: pc.magenta,
  OPTIONS: pc.magenta,
};

export function printRoutes(
  routes: Array<{ path: string; methods: string[] }>,
) {
  if (routes.length === 0) return;

  const rows = routes
    .flatMap((r) => r.methods.map((m) => ({ method: m, path: r.path })))
    .sort(
      (a, b) =>
        a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
    );

  const maxMethodLen = Math.max(...rows.map((r) => r.method.length));
  const separator = pc.dim("─".repeat(50));

  const colorizeParams = (p: string) =>
    p.replace(/(:[a-zA-Z_]\w*)/g, (match) => pc.cyan(match));

  console.log("");
  console.log(
    `  ${pc.bold("Registered Routes")} ${pc.dim(`(${rows.length})`)}`,
  );
  console.log(`  ${separator}`);

  for (const { method, path } of rows) {
    const colorize = METHOD_COLORS[method] || pc.white;
    const methodStr = colorize(pc.bold(method.padEnd(maxMethodLen)));
    console.log(`  ${methodStr}  ${colorizeParams(path)}`);
  }

  console.log(`  ${separator}`);
  console.log("");
}

export function getQueries(configFolder: string) {
  const queriesFolder = path.join(configFolder, "queries");

  if (!fs.existsSync(queriesFolder)) {
    return {};
  }

  return Object.fromEntries(
    fs
      .readdirSync(queriesFolder)
      .filter((f) => path.extname(f) === ".sql")
      .map((f) => [path.basename(f, ".sql"), path.basename(f, ".sql")]),
  );
}

import type { PluginEndpoints } from "shared";

export type { PluginEndpoints };

interface RuntimeConfig {
  appName: string;
  queries: Record<string, string>;
  endpoints: PluginEndpoints;
}

function getRuntimeConfig(endpoints: PluginEndpoints = {}): RuntimeConfig {
  const configFolder = path.join(process.cwd(), "config");

  return {
    appName: process.env.DATABRICKS_APP_NAME || "",
    queries: getQueries(configFolder),
    endpoints,
  };
}

export function getConfigScript(endpoints: PluginEndpoints = {}): string {
  const config = getRuntimeConfig(endpoints);

  return `
    <script>
      window.__CONFIG__ = ${JSON.stringify(config)};
    </script>
  `;
}
