import pc from "picocolors";
import { createLogger } from "../../logging/logger";

const logger = createLogger("server:config");

const REDACTED_CLIENT_CONFIG_VALUE = "[redacted by appkit]";
const MIN_SUBSTRING_LENGTH = 3;
const DISALLOWED_CLIENT_CONFIG_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Builds a Map of non-public env var values (value -> key names)
 * and a Set of public env var values for overlap resolution.
 */
function getEnvValueSets(): {
  nonPublic: Map<string, string[]>;
  publicValues: Set<string>;
} {
  const nonPublic = new Map<string, string[]>();
  const publicValues = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (key.startsWith("PUBLIC_APPKIT_")) {
      publicValues.add(value);
    } else {
      const existing = nonPublic.get(value);
      if (existing) {
        existing.push(key);
      } else {
        nonPublic.set(value, [key]);
      }
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
  nonPublicValues: Map<string, string[]>,
  publicValues: Set<string>,
  leakedVars: Set<string>,
): string {
  for (const [envValue, envKeys] of nonPublicValues) {
    if (value === envValue && !publicValues.has(envValue)) {
      for (const k of envKeys) leakedVars.add(k);
      return REDACTED_CLIENT_CONFIG_VALUE;
    }
    if (
      envValue.length >= MIN_SUBSTRING_LENGTH &&
      value.includes(envValue) &&
      !isSecretCoveredByPublicValue(value, envValue, publicValues)
    ) {
      for (const k of envKeys) leakedVars.add(k);
      return REDACTED_CLIENT_CONFIG_VALUE;
    }
  }

  return value;
}

function redactLeakedValues(
  obj: unknown,
  nonPublicValues: Map<string, string[]>,
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
