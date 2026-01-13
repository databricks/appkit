import { format } from "node:util";
import { createDebug as createObug } from "obug";

/**
 * Logger interface for AppKit components
 */
export interface Logger {
  /** Debug output (disabled by default, enable via DEBUG env var) */
  debug: (message: string, ...args: unknown[]) => void;
  /** Info output (always visible, for operational messages) */
  info: (message: string, ...args: unknown[]) => void;
  /** Warning output (always visible, for degraded states) */
  warn: (message: string, ...args: unknown[]) => void;
  /** Error output (always visible, for failures) */
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Create a logger instance for a specific scope
 * @param scope - The scope identifier (e.g., "connectors:lakebase")
 * @returns Logger instance with debug, info, warn, and error methods
 *
 * @example
 * ```typescript
 * const logger = createLogger("connectors:lakebase");
 * logger.debug("Connection established with pool size: %d", poolSize);
 * logger.info("Server started on port %d", port);
 * logger.warn("Connection pool running low: %d remaining", available);
 * logger.error("Failed to connect: %O", error);
 * ```
 */
export function createLogger(scope: string): Logger {
  const debug = createObug(`appkit:${scope}`, { useColors: true });
  const prefix = `[appkit:${scope}]`;

  return {
    debug: (message: string, ...args: unknown[]) => {
      debug(message, ...args);
    },
    info: (message: string, ...args: unknown[]) => {
      console.log(prefix, format(message, ...args));
    },
    warn: (message: string, ...args: unknown[]) => {
      console.warn(prefix, format(message, ...args));
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(prefix, format(message, ...args));
    },
  };
}
