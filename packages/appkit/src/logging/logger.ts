import { format } from "node:util";
import { trace } from "@opentelemetry/api";
import type { Request, Response } from "express";
import { createDebug as createObug } from "obug";
import { DEFAULT_SAMPLING_CONFIG, shouldSample } from "./sampling";
import { WideEvent } from "./wide-event";
import { WideEventEmitter } from "./wide-event-emitter";

/**
 * Logger interface for AppKit components
 */
export interface Logger {
  /** Debug output (disabled by default, enable via DEBUG env var) */
  debug(message: string, ...args: unknown[]): void;
  debug(req: Request, message: string, ...args: unknown[]): void;

  /** Info output (always visible, for operational messages) */
  info(message: string, ...args: unknown[]): void;
  info(req: Request, message: string, ...args: unknown[]): void;

  /** Warning output (always visible, for degraded states) */
  warn(message: string, ...args: unknown[]): void;
  warn(req: Request, message: string, ...args: unknown[]): void;

  /** Error output (always visible, for failures) */
  error(message: string, ...args: unknown[]): void;
  error(req: Request, message: string, ...args: unknown[]): void;

  /** Get or create request-scoped WideEvent */
  event(req: Request): WideEvent;
}

// WeakMap to store WideEvent per request
const eventsByRequest = new WeakMap<Request, WideEvent>();

// Global emitter instance
const emitter = new WideEventEmitter();

const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Sanitize a request ID from user headers
 */
function sanitizeRequestId(id: string): string {
  // Remove any characters that aren't alphanumeric, dash, underscore, or dot
  const sanitized = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  // Limit length
  return sanitized.slice(0, MAX_REQUEST_ID_LENGTH);
}

/**
 * Generate a request ID from the request
 */
function generateRequestId(req: Request): string {
  // Use existing request ID if available
  const existingId =
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    req.headers["x-amzn-trace-id"];

  if (existingId && typeof existingId === "string" && existingId.length > 0) {
    const sanitized = sanitizeRequestId(existingId);
    if (sanitized.length > 0) {
      return sanitized;
    }
  }

  // Generate a simple ID based on timestamp and random
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get or create a WideEvent for the given request
 */
function getOrCreateEvent(req: Request): WideEvent {
  let wideEvent = eventsByRequest.get(req);

  if (!wideEvent) {
    const requestId = generateRequestId(req);
    wideEvent = new WideEvent(requestId);

    // Set initial request metadata
    const path = req.path || req.url || req.originalUrl;
    wideEvent.set("method", req.method).set("path", path);

    // Extract user ID from request headers
    const userId = req.headers["x-forwarded-user"] as string | undefined;
    if (userId) {
      wideEvent.setUser({ id: userId });
    }

    // Extract trace ID from active span for distributed tracing
    const currentSpan = trace.getActiveSpan();
    const spanContext = currentSpan?.spanContext();
    if (spanContext?.traceId) {
      wideEvent.set("trace_id", spanContext.traceId);

      const debugLogger = createObug("appkit:logger:event", {
        useColors: true,
      });
      debugLogger(
        "WideEvent created: %s %s (reqId: %s, traceId: %s)",
        req.method,
        path,
        requestId.substring(0, 8),
        spanContext.traceId.substring(0, 8),
      );
    }

    // Update service scope
    if (wideEvent.data.service) {
      wideEvent.data.service = {
        ...wideEvent.data.service,
        name: "appkit",
      };
    }

    eventsByRequest.set(req, wideEvent);

    // Auto-finalize on response finish
    const res = req.res as Response | undefined;
    if (res) {
      res.once("finish", () => {
        const event = eventsByRequest.get(req);
        if (event) {
          // Finalize the event with status code
          const finalizedData = event.finalize(res.statusCode || 200);

          // Emit to OpenTelemetry if sampled
          const sampled = shouldSample(finalizedData, DEFAULT_SAMPLING_CONFIG);

          if (sampled) {
            emitter.emit(finalizedData);
          }

          // Clean up to prevent memory leaks
          eventsByRequest.delete(req);
        }
      });

      // Also handle aborted requests
      res.once("close", () => {
        if (!res.writableFinished) {
          // Request was aborted/cancelled
          const event = eventsByRequest.get(req);

          if (event) {
            // Try to end the active span with error status
            const currentSpan = trace.getActiveSpan();
            if (currentSpan) {
              currentSpan.setStatus({
                code: 1, // ERROR
                message: "Request aborted by client",
              });
              currentSpan.end();
            }
          }

          eventsByRequest.delete(req);
        }
      });
    }
  }

  return wideEvent;
}

/**
 * Check if the first argument is an Express Request
 */
function isRequest(arg: unknown): arg is Request {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "method" in arg &&
    "path" in arg &&
    typeof (arg as Request).method === "string"
  );
}

/**
 * Create a logger instance for a specific scope
 * @param scope - The scope identifier (e.g., "connectors:lakebase")
 * @returns Logger instance with debug, info, warn, and error methods
 *
 * @example
 * ```typescript
 * const logger = createLogger("connectors:lakebase");
 *
 * // Regular logging (no request tracking)
 * logger.debug("Connection established with pool size: %d", poolSize);
 * logger.info("Server started on port %d", port);
 *
 * // Request-scoped logging (tracks in WideEvent)
 * logger.debug(req, "Processing query: %s", queryId);
 * logger.error(req, "Query failed: %O", error);
 *
 * // Get WideEvent for manual updates
 * const event = logger.event(req);
 * event.setComponent("analytics", "executeQuery");
 * ```
 */
export function createLogger(scope: string): Logger {
  const debug = createObug(`appkit:${scope}`, { useColors: true });
  const prefix = `[appkit:${scope}]`;

  function debugLog(reqOrMessage: Request | string, ...args: unknown[]): void {
    if (isRequest(reqOrMessage)) {
      const req = reqOrMessage;
      const message = args[0] as string;
      const logArgs = args.slice(1);
      const formatted = format(message, ...logArgs);

      debug(message, ...logArgs);
      getOrCreateEvent(req).addLog("debug", formatted);
    } else {
      debug(reqOrMessage, ...args);
    }
  }

  function infoLog(reqOrMessage: Request | string, ...args: unknown[]): void {
    if (isRequest(reqOrMessage)) {
      const req = reqOrMessage;
      const message = args[0] as string;
      const logArgs = args.slice(1);
      const formatted = format(message, ...logArgs);

      console.log(prefix, formatted);
      getOrCreateEvent(req).addLog("info", formatted);
    } else {
      console.log(prefix, format(reqOrMessage, ...args));
    }
  }

  function warnLog(reqOrMessage: Request | string, ...args: unknown[]): void {
    if (isRequest(reqOrMessage)) {
      const req = reqOrMessage;
      const message = args[0] as string;
      const logArgs = args.slice(1);
      const formatted = format(message, ...logArgs);

      console.warn(prefix, formatted);
      getOrCreateEvent(req).addLog("warn", formatted);
    } else {
      console.warn(prefix, format(reqOrMessage, ...args));
    }
  }

  function errorLog(reqOrMessage: Request | string, ...args: unknown[]): void {
    if (isRequest(reqOrMessage)) {
      const req = reqOrMessage;
      const message = args[0] as string;
      const logArgs = args.slice(1);
      const formatted = format(message, ...logArgs);

      console.error(prefix, formatted);
      getOrCreateEvent(req).addLog("error", formatted);
    } else {
      console.error(prefix, format(reqOrMessage, ...args));
    }
  }

  function event(req: Request): WideEvent {
    return getOrCreateEvent(req);
  }

  return {
    debug: debugLog as Logger["debug"],
    info: infoLog as Logger["info"],
    warn: warnLog as Logger["warn"],
    error: errorLog as Logger["error"],
    event,
  };
}
