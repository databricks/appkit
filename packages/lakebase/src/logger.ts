import type { Logger, LoggerConfig } from "./types";

const LOGGER_METHODS = ["debug", "info", "warn", "error"] as const;

/**
 * Check if the provided value is a Logger instance
 */
function isLogger(value: unknown): value is Logger {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return LOGGER_METHODS.every(
    (method) =>
      method in value &&
      typeof (value as Record<string, unknown>)[method] === "function",
  );
}

/**
 * Create a console-based logger from configuration
 */
function createConsoleLogger(config: LoggerConfig): Logger {
  const noop = () => {};

  return {
    debug: config.debug ? console.debug.bind(console) : noop,
    info: config.info ? console.info.bind(console) : noop,
    warn: config.warn ? console.warn.bind(console) : noop,
    error: config.error ? console.error.bind(console) : noop,
  };
}

/**
 * Resolve logger configuration to a Logger instance
 *
 * - If Logger instance provided, return as-is
 * - If LoggerConfig provided, create console-based logger
 * - If undefined, create error-only logger (default)
 */
export function resolveLogger(loggerConfig?: Logger | LoggerConfig): Logger {
  // Already a Logger instance - use as-is
  if (isLogger(loggerConfig)) {
    return loggerConfig;
  }

  // LoggerConfig provided - create console logger
  if (loggerConfig && typeof loggerConfig === "object") {
    return createConsoleLogger(loggerConfig);
  }

  // Default: error-only logging
  return createConsoleLogger({ error: true });
}
