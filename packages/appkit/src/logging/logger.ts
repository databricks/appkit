import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { trace } from "@opentelemetry/api";
import type { NextFunction, Request, Response } from "express";
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

  /** Get request-scoped WideEvent (from AsyncLocalStorage or explicit req) */
  event(req?: Request): WideEvent | undefined;
}

// AsyncLocalStorage for WideEvent context propagation
const eventStorage = new AsyncLocalStorage<WideEvent>();

// WeakMap to store WideEvent per request (for explicit req usage)
const eventsByRequest = new WeakMap<Request, WideEvent>();

// Global emitter instance
const emitter = new WideEventEmitter();

const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Sanitize a request ID from user headers
 */
function sanitizeRequestId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  return sanitized.slice(0, MAX_REQUEST_ID_LENGTH);
}

/**
 * Generate a request ID from the request
 */
function generateRequestId(req: Request): string {
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

  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a WideEvent for a request
 */
function createEventForRequest(req: Request): WideEvent {
  const requestId = generateRequestId(req);
  const wideEvent = new WideEvent(requestId);

  // extract path from request (strip query string)
  const rawPath = req.path || req.url || req.originalUrl;
  const path = rawPath?.split("?")[0];
  wideEvent.set("method", req.method).set("path", path);

  // extract user id from request headers (sanitized)
  const rawUserId = req.headers["x-forwarded-user"];
  if (rawUserId && typeof rawUserId === "string" && rawUserId.length > 0) {
    const userId = rawUserId.replace(/[^a-zA-Z0-9_@.-]/g, "").slice(0, 128);
    if (userId.length > 0) {
      wideEvent.setUser({ id: userId });
    }
  }

  // extract trace id from active span for distributed tracing
  const currentSpan = trace.getActiveSpan();
  const spanContext = currentSpan?.spanContext();
  if (spanContext?.traceId) {
    wideEvent.set("trace_id", spanContext.traceId);

    const debugLogger = createObug("appkit:logger:event", { useColors: true });
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

  return wideEvent;
}

/**
 * Setup response lifecycle handlers for WideEvent finalization
 */
function setupResponseHandlers(req: Request, wideEvent: WideEvent): void {
  const res = req.res as Response | undefined;
  if (!res) return;

  res.once("finish", () => {
    // finalize the event with status code
    const finalizedData = wideEvent.finalize(res.statusCode || 200);

    // emit to OpenTelemetry if sampled
    if (shouldSample(finalizedData, DEFAULT_SAMPLING_CONFIG)) {
      emitter.emit(finalizedData);
    }

    // clean up the WeakMap
    eventsByRequest.delete(req);
  });

  res.once("close", () => {
    if (!res.writableFinished) {
      // request was aborted - just cleanup
      eventsByRequest.delete(req);
    }
  });
}

/**
 * Express middleware that establishes AsyncLocalStorage context for WideEvent.
 * This properly scopes the context to the entire request lifecycle using run().
 *
 * @example
 * ```typescript
 * import { wideEventMiddleware } from "@databricks/appkit";
 *
 * app.use(wideEventMiddleware);
 * ```
 */
export function wideEventMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const wideEvent = createEventForRequest(req);
  eventsByRequest.set(req, wideEvent);
  setupResponseHandlers(req, wideEvent);

  // run() scopes the context to this request's entire async chain
  eventStorage.run(wideEvent, next);
}

/**
 * Get or create a WideEvent for the given request.
 * If called within wideEventMiddleware context, returns the event from AsyncLocalStorage.
 * Otherwise creates a new event for the request.
 */
function getOrCreateEvent(req: Request): WideEvent {
  // first check if we already have an event
  let wideEvent = eventsByRequest.get(req);

  if (!wideEvent) {
    // check if we are in a middleware context
    const alsEvent = eventStorage.getStore();
    if (alsEvent) {
      // store the event in the WeakMap
      eventsByRequest.set(req, alsEvent);
      return alsEvent;
    }

    // no middleware context - create event directly
    wideEvent = createEventForRequest(req);
    eventsByRequest.set(req, wideEvent);
    setupResponseHandlers(req, wideEvent);
  }

  return wideEvent;
}

/**
 * Get current WideEvent from AsyncLocalStorage or request
 */
function getCurrentEvent(req?: Request): WideEvent | undefined {
  // if req provided, use it
  if (req) {
    return getOrCreateEvent(req);
  }

  // otherwise, get from AsyncLocalStorage
  return eventStorage.getStore();
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
 * // Get WideEvent - works in route handlers (with req) or interceptors (from context)
 * const event = logger.event(req);  // In route handler
 * const event = logger.event();     // In interceptor (gets from AsyncLocalStorage)
 * event?.setComponent("analytics", "executeQuery");
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

  function event(req?: Request): WideEvent | undefined {
    return getCurrentEvent(req);
  }

  return {
    debug: debugLog as Logger["debug"],
    info: infoLog as Logger["info"],
    warn: warnLog as Logger["warn"],
    error: errorLog as Logger["error"],
    event,
  };
}
