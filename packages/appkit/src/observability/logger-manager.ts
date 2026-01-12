import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eventStorage, formatAndEmitWideEvent } from "./context";
import { createDebug } from "./debug";
import { Logger } from "./logger";
import { OTELBridge } from "./otel/bridge";
import type { ObservabilityConfig, ObservabilityOptions } from "./types";
import { WideEvent, type WideEventData } from "./wide-event";

const debug = createDebug("observability");

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;

/**
 * Sanitize request ID to prevent log injection attacks.
 * - Validates format (alphanumeric + safe chars only)
 * - Clamps length to prevent DoS
 * - Falls back to generated UUID if invalid
 */
function sanitizeRequestId(rawId: string | undefined): string {
  if (!rawId) return crypto.randomUUID();

  const trimmed = rawId.slice(0, MAX_REQUEST_ID_LENGTH);

  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    return crypto.randomUUID();
  }

  return trimmed;
}

/**
 * Logger Manager
 * - Responsible for initializing the OTEL bridge and creating loggers
 * - Provides a singleton instance of the LoggerManager
 * - Provides a method to get the OTEL bridge
 * - Provides a method to get the middleware
 * - Provides a method to shutdown the LoggerManager
 */
export class LoggerManager {
  private static instance?: LoggerManager;
  private otelBridge: OTELBridge;

  private constructor(config: ObservabilityConfig = {}) {
    this.otelBridge = new OTELBridge(config);
    debug("LoggerManager initialized", { config });
  }

  static initialize(config: ObservabilityConfig = {}): void {
    if (LoggerManager.instance) {
      debug("LoggerManager already initialized, skipping");
      return;
    }
    LoggerManager.instance = new LoggerManager(config);
  }

  static getInstance(): LoggerManager {
    if (!LoggerManager.instance) {
      LoggerManager.instance = new LoggerManager();
    }
    return LoggerManager.instance;
  }

  static getLogger(scope: string, config?: ObservabilityOptions): Logger {
    const manager = LoggerManager.getInstance();
    return manager.createLogger(scope, config);
  }

  static getOTELBridge(): OTELBridge {
    const manager = LoggerManager.getInstance();
    return manager.otelBridge;
  }

  /**
   * Get the observability middleware.
   * Creates WideEvent, formats to terminal, and sends to OTEL.
   */
  static getMiddleware(): RequestHandler {
    const manager = LoggerManager.getInstance();

    return (req: Request, res: Response, next: NextFunction) => {
      const requestId = sanitizeRequestId(
        req.headers["x-request-id"] as string,
      );
      res.setHeader("x-request-id", requestId);

      // Create WideEvent and set initial context
      const event = new WideEvent(requestId);
      event.set("method", req.method);
      event.set("path", req.path);

      // Set user context if available (only id for security)
      if ((req as any).user?.id) {
        event.setUser({ id: (req as any).user.id });
      }

      // On response finish: format to terminal AND send to OTEL
      res.on("finish", () => {
        const data = formatAndEmitWideEvent(event, res.statusCode);
        if (data) {
          manager.emitWideEventToOTEL(data);
        }
      });

      // Run in AsyncLocalStorage context
      eventStorage.run(event, () => next());
    };
  }

  static async shutdown(): Promise<void> {
    if (LoggerManager.instance) {
      await LoggerManager.instance.otelBridge.shutdown();
      LoggerManager.instance = undefined;
      debug("LoggerManager shutdown complete");
    }
  }

  /**
   * Emit WideEvent to OTEL Logs.
   * This is called by the WideEvent middleware at request end.
   * @internal
   */
  private emitWideEventToOTEL(event: WideEventData): void {
    try {
      if (!this.otelBridge.isEnabled()) return;

      const logger = this.otelBridge.getLogger("appkit.wide-event");

      // Determine severity based on status code and errors
      let severityNumber = 9; // INFO
      if (event.error) {
        severityNumber = 17; // ERROR
      } else if (event.status_code && event.status_code >= 400) {
        severityNumber = 17; // ERROR
      } else if (event.status_code && event.status_code >= 300) {
        severityNumber = 13; // WARN
      }

      logger.emit({
        body: JSON.stringify(event),
        severityNumber,
      });

      debug("WideEvent emitted to OTEL", {
        request_id: event.request_id,
        status_code: event.status_code,
      });
    } catch (error) {
      // Silently fail - don't break the app if OTEL is down
      debug("Failed to emit WideEvent to OTEL", { error });
    }
  }

  private createLogger(scope: string, config?: ObservabilityOptions): Logger {
    const scopedOtel = this.otelBridge.createScoped(scope, config);
    return new Logger(scope, scopedOtel);
  }
}
