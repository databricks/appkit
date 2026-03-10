import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import pc from "picocolors";
import type { PluginClientConfigs, PluginEndpoints } from "shared";
import { createLogger } from "../../logging/logger";

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

export type { PluginClientConfigs, PluginEndpoints };

interface RuntimeConfig {
  appName: string;
  queries: Record<string, string>;
  endpoints: PluginEndpoints;
  plugins: PluginClientConfigs;
}

const APPKIT_CONFIG_SCRIPT_ID = "__appkit__";
const REDACTED_CLIENT_CONFIG_VALUE = "[redacted by appkit]";
const MIN_SUBSTRING_LENGTH = 3;
const DISALLOWED_CLIENT_CONFIG_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
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

const logger = createLogger("server:config");

function serializeRuntimeConfig(config: RuntimeConfig): string {
  return JSON.stringify(config).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_SCRIPT_ESCAPE_MAP[char] ?? char,
  );
}

/**
 * Builds a Map of non-public env var values (value -> key name)
 * and a Set of public env var values for overlap resolution.
 */
function getEnvValueSets(): {
  nonPublic: Map<string, string>;
  publicValues: Set<string>;
} {
  const nonPublic = new Map<string, string>();
  const publicValues = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (key.startsWith("PUBLIC_APPKIT_")) {
      publicValues.add(value);
    } else {
      nonPublic.set(value, key);
    }
  }
  return { nonPublic, publicValues };
}

function getMatchRanges(
  haystack: string,
  needle: string,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let startIndex = 0;

  while (startIndex < haystack.length) {
    const matchIndex = haystack.indexOf(needle, startIndex);
    if (matchIndex === -1) {
      break;
    }
    ranges.push([matchIndex, matchIndex + needle.length]);
    startIndex = matchIndex + 1;
  }

  return ranges;
}

function isSecretCoveredByPublicValue(
  value: string,
  envValue: string,
  publicValues: Set<string>,
): boolean {
  const publicRanges = [...publicValues]
    .filter((publicValue) => publicValue.includes(envValue))
    .flatMap((publicValue) => getMatchRanges(value, publicValue));

  if (publicRanges.length === 0) {
    return false;
  }

  return getMatchRanges(value, envValue).every(([secretStart, secretEnd]) =>
    publicRanges.some(
      ([publicStart, publicEnd]) =>
        publicStart <= secretStart && publicEnd >= secretEnd,
    ),
  );
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidClientConfig(
  pluginName: string,
  path: string,
  message: string,
): Error {
  return new Error(
    `Plugin '${pluginName}' clientConfig() ${message} at ${path}. Only JSON-serializable plain data is supported.`,
  );
}

function assertSafeClientConfigKey(
  pluginName: string,
  key: string,
  path: string,
): void {
  if (DISALLOWED_CLIENT_CONFIG_KEYS.has(key)) {
    throw invalidClientConfig(
      pluginName,
      `${path}.${key}`,
      "contains a reserved key",
    );
  }
}

function validateClientConfigValue(
  pluginName: string,
  value: unknown,
  path: string,
  stack: WeakSet<object>,
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw invalidClientConfig(
          pluginName,
          path,
          "contains a non-finite number",
        );
      }
      return value;
    case "bigint":
      throw invalidClientConfig(pluginName, path, "contains a BigInt");
    case "undefined":
      return undefined;
    case "function":
      throw invalidClientConfig(pluginName, path, "contains a function");
    case "symbol":
      throw invalidClientConfig(pluginName, path, "contains a symbol");
  }

  if (Array.isArray(value)) {
    if (stack.has(value)) {
      throw invalidClientConfig(
        pluginName,
        path,
        "contains a circular reference",
      );
    }

    stack.add(value);
    const result = value.map(
      (item, index) =>
        validateClientConfigValue(
          pluginName,
          item,
          `${path}[${index}]`,
          stack,
        ) ?? null,
    );
    stack.delete(value);
    return result;
  }

  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw invalidClientConfig(
        pluginName,
        path,
        "contains a non-plain object",
      );
    }
    if (stack.has(value)) {
      throw invalidClientConfig(
        pluginName,
        path,
        "contains a circular reference",
      );
    }

    stack.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      assertSafeClientConfigKey(pluginName, key, path);
      const normalizedValue = validateClientConfigValue(
        pluginName,
        nestedValue,
        `${path}.${key}`,
        stack,
      );
      if (normalizedValue !== undefined) {
        result[key] = normalizedValue;
      }
    }
    stack.delete(value);
    return result;
  }

  throw invalidClientConfig(pluginName, path, "contains an unsupported value");
}

function validateClientConfig(
  pluginName: string,
  config: unknown,
): Record<string, unknown> {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(
      `Plugin '${pluginName}' clientConfig() must return a plain object.`,
    );
  }

  return validateClientConfigValue(
    pluginName,
    config,
    "clientConfig()",
    new WeakSet(),
  ) as Record<string, unknown>;
}

/**
 * Redacts a string when it contains a non-public env var value. Exact matches
 * are caught regardless of length; substring containment requires the env value
 * to be at least MIN_SUBSTRING_LENGTH chars to avoid false positives from very
 * short values.
 */
function redactLeakedString(
  value: string,
  nonPublicValues: Map<string, string>,
  publicValues: Set<string>,
  leakedVars: Set<string>,
): string {
  for (const [envValue, envKey] of nonPublicValues) {
    if (value === envValue && !publicValues.has(envValue)) {
      leakedVars.add(envKey);
      return REDACTED_CLIENT_CONFIG_VALUE;
    }
    if (
      envValue.length >= MIN_SUBSTRING_LENGTH &&
      value.includes(envValue) &&
      !isSecretCoveredByPublicValue(value, envValue, publicValues)
    ) {
      leakedVars.add(envKey);
      return REDACTED_CLIENT_CONFIG_VALUE;
    }
  }

  return value;
}

function redactLeakedValues(
  obj: unknown,
  nonPublicValues: Map<string, string>,
  publicValues: Set<string>,
  leakedVars: Set<string>,
): unknown {
  if (typeof obj === "string") {
    return redactLeakedString(obj, nonPublicValues, publicValues, leakedVars);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      redactLeakedValues(item, nonPublicValues, publicValues, leakedVars),
    );
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const redactedKey = redactLeakedString(
        key,
        nonPublicValues,
        publicValues,
        leakedVars,
      );
      const uniqueKey = getUniqueObjectKey(redactedKey, result);
      result[uniqueKey] = redactLeakedValues(
        value,
        nonPublicValues,
        publicValues,
        leakedVars,
      );
    }
    return result;
  }

  return obj;
}

function getUniqueObjectKey(
  key: string,
  result: Record<string, unknown>,
): string {
  if (!Object.hasOwn(result, key)) {
    return key;
  }

  let suffix = 2;
  let candidate = `${key} (${suffix})`;
  while (Object.hasOwn(result, candidate)) {
    suffix += 1;
    candidate = `${key} (${suffix})`;
  }

  return candidate;
}

/**
 * Scans a plugin's clientConfig return value for string values that
 * match or contain non-public environment variable values. Matches are
 * replaced with "[redacted by appkit]" and a warning is logged.
 *
 * Only env vars prefixed with `PUBLIC_APPKIT_` are allowed through;
 * all other process.env values are treated as sensitive.
 */
export function sanitizeClientConfig(
  pluginName: string,
  config: unknown,
): Record<string, unknown> {
  const validated = validateClientConfig(pluginName, config);
  const { nonPublic, publicValues } = getEnvValueSets();
  if (nonPublic.size === 0) return validated;

  const leakedVars = new Set<string>();
  const sanitized = redactLeakedValues(
    validated,
    nonPublic,
    publicValues,
    leakedVars,
  ) as Record<string, unknown>;

  if (leakedVars.size > 0) {
    const banner = formatLeakedVarsBanner(pluginName, leakedVars);
    logger.warn("\n\n%s\n", banner);
  }

  return sanitized;
}

function formatLeakedVarsBanner(
  pluginName: string,
  leakedVars: Set<string>,
): string {
  const s = leakedVars.size === 1 ? "" : "s";
  const contentLines: string[] = [
    `${pc.bold(pluginName)}.clientConfig() contained ${pc.bold(String(leakedVars.size))} env var value${s}`,
    `that would have been sent to the browser. AppKit ${pc.green("redacted")} them automatically.`,
    "",
    ...Array.from(leakedVars, (v) => `  ${pc.red("-")} ${pc.yellow(v)}`),
    "",
    `To intentionally expose a value, set a matching ${pc.green("PUBLIC_APPKIT_")} variable.`,
    `Example: ${pc.dim('PUBLIC_APPKIT_MY_VAR="safe-value"')}`,
  ];

  // biome-ignore lint: stripping ANSI escape sequences requires matching the ESC control character
  const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, "");
  const maxLen = Math.max(...contentLines.map((l) => stripAnsi(l).length));
  const border = pc.yellow("=".repeat(maxLen + 4));
  const boxed = contentLines.map(
    (line) =>
      `${pc.yellow("|")} ${line}${" ".repeat(maxLen - stripAnsi(line).length)} ${pc.yellow("|")}`,
  );

  return [border, ...boxed, border].join("\n");
}
