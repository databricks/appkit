import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import pc from "picocolors";
import type { PluginClientConfigs, PluginEndpoints } from "shared";

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

type RouteLine = { method: string; path: string };

/**
 * Fold lines that share a method and differ in exactly one static segment:
 * `/api/{a,b}/:id` instead of `/api/a/:id` and `/api/b/:id`. The largest fold
 * is taken first, so each route lands on exactly one line.
 */
export function collapseRoutes(lines: RouteLine[]): RouteLine[] {
  const pending = new Map(
    lines.map((line) => [`${line.method} ${line.path}`, line]),
  );
  const collapsed: RouteLine[] = [];

  while (pending.size > 0) {
    const folds = new Map<string, { index: number; members: RouteLine[] }>();
    let best: { index: number; members: RouteLine[] } | undefined;
    for (const line of pending.values()) {
      const segments = line.path.split("/");
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        // Only fixed path parts fold; parameters and patterns keep their own line.
        if (segment === "" || /[:*?(){}[\],]/.test(segment)) continue;
        const masked = segments.slice();
        masked[index] = "\0";
        const key = `${line.method} ${masked.join("/")}`;
        let fold = folds.get(key);
        if (!fold) {
          fold = { index, members: [] };
          folds.set(key, fold);
        }
        fold.members.push(line);
        if (fold.members.length > (best?.members.length ?? 1)) best = fold;
      }
    }
    if (!best) {
      collapsed.push(...pending.values());
      break;
    }

    const { index, members } = best;
    const segments = members[0].path.split("/");
    const names = members.map((m) => m.path.split("/")[index]).sort();
    segments[index] = `{${names.join(",")}}`;
    collapsed.push({ method: members[0].method, path: segments.join("/") });
    for (const m of members) pending.delete(`${m.method} ${m.path}`);
  }

  return collapsed.sort(
    (a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
  );
}

export function printRoutes(
  routes: Array<{ path: string; methods: string[] }>,
) {
  if (routes.length === 0) return;

  const rows = routes.flatMap((r) =>
    r.methods.map((m) => ({ method: m, path: r.path })),
  );
  const lines = collapseRoutes(rows);

  const maxMethodLen = Math.max(...lines.map((r) => r.method.length));
  const separator = pc.dim("─".repeat(50));
  const width = process.stdout.columns || 80;
  const pathColumn = 2 + maxMethodLen + 2;
  // A `{a,b}` segment folded by `collapseRoutes`.
  const foldSegment = /^\{[^{}:,/]+(,[^{}:,/]+)+\}$/;
  // A fold too wide for its line prints once, in the legend, under a label.
  const legend = new Map<string, string>();

  console.log("");
  console.log(
    `  ${pc.bold("Registered Routes")} ${pc.dim(`(${rows.length})`)}`,
  );
  console.log(`  ${separator}`);

  for (const { method, path } of lines) {
    const colorize = METHOD_COLORS[method] || pc.white;
    const methodStr = colorize(pc.bold(method.padEnd(maxMethodLen)));
    const fits = pathColumn + path.length <= width;
    const painted = path
      .split("/")
      .map((segment) => {
        if (!foldSegment.test(segment)) {
          return segment.replace(/(:[a-zA-Z_]\w*)/g, (m) => pc.cyan(m));
        }
        if (fits) return segment.replace(/[{},]/g, (c) => pc.dim(c));
        let label = legend.get(segment);
        if (!label) {
          label = `{#${legend.size + 1}}`;
          legend.set(segment, label);
        }
        return pc.magenta(label);
      })
      .join("/");
    console.log(`  ${methodStr}  ${painted}`);
  }

  if (legend.size > 0) console.log("");
  // Long name lists read better as a narrow block than as one screen-wide line.
  const legendWidth = Math.min(width, 80);
  for (const [segment, label] of legend) {
    const indent = " ".repeat(label.length + 2);
    const wrapped: string[] = [];
    let current = "";
    for (const name of segment.slice(1, -1).split(",")) {
      const next = current ? `${current}, ${name}` : name;
      // +1 leaves room for the trailing comma of a wrapped line.
      if (current && 2 + indent.length + next.length + 1 > legendWidth) {
        wrapped.push(`${current},`);
        current = name;
      } else {
        current = next;
      }
    }
    wrapped.push(current);
    wrapped.forEach((text, i) => {
      const head = i === 0 ? `${pc.magenta(label)}  ` : indent;
      console.log(`  ${head}${text}`);
    });
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

export type { PluginClientConfigs, PluginEndpoints };

interface RuntimeConfig {
  appName: string;
  queries: Record<string, string>;
  endpoints: PluginEndpoints;
  plugins: PluginClientConfigs;
}

const APPKIT_CONFIG_SCRIPT_ID = "__appkit__";
const EMPTY_RUNTIME_CONFIG: RuntimeConfig = {
  appName: "",
  queries: {},
  endpoints: {},
  plugins: {},
};
const EMPTY_RUNTIME_CONFIG_JSON = JSON.stringify(EMPTY_RUNTIME_CONFIG);
const JSON_SCRIPT_ESCAPE_MAP: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function getRuntimeConfig(
  endpoints: PluginEndpoints = {},
  pluginConfigs: PluginClientConfigs = {},
): RuntimeConfig {
  const configFolder = path.join(process.cwd(), "config");

  return {
    appName: process.env.DATABRICKS_APP_NAME || "",
    queries: getQueries(configFolder),
    endpoints,
    plugins: pluginConfigs,
  };
}

export function getConfigScript(
  endpoints: PluginEndpoints = {},
  pluginConfigs: PluginClientConfigs = {},
): string {
  const config = getRuntimeConfig(endpoints, pluginConfigs);

  return `
    <script id="${APPKIT_CONFIG_SCRIPT_ID}" type="application/json">
      ${serializeRuntimeConfig(config)}
    </script>
    <script>
      window.__appkit__ = JSON.parse(
        document.getElementById("${APPKIT_CONFIG_SCRIPT_ID}")?.textContent ||
          '${EMPTY_RUNTIME_CONFIG_JSON}',
      );
    </script>
  `;
}

function serializeRuntimeConfig(config: RuntimeConfig): string {
  return JSON.stringify(config).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_SCRIPT_ESCAPE_MAP[char] ?? char,
  );
}
