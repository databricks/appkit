import { format } from "node:util";

/**
 * Simple logger interface for the Lakebase driver
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Check if DEBUG environment variable enables this scope
 */
function isDebugEnabled(scope: string): boolean {
  const debug = process.env.DEBUG;
  if (!debug) return false;

  const patterns = debug.split(",").map((p) => p.trim());
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === scope) return true;
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return scope.startsWith(prefix);
    }
    return false;
  });
}

/**
 * Create a logger instance for a specific scope
 */
export function createLogger(scope: string): Logger {
  const prefix = `[@databricks/lakebase:${scope}]`;
  const debugEnabled = isDebugEnabled(`lakebase:${scope}`);

  return {
    debug(message: string, ...args: unknown[]): void {
      if (debugEnabled) {
        console.debug(prefix, format(message, ...args));
      }
    },
    info(message: string, ...args: unknown[]): void {
      console.log(prefix, format(message, ...args));
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(prefix, format(message, ...args));
    },
    error(message: string, ...args: unknown[]): void {
      console.error(prefix, format(message, ...args));
    },
  };
}
