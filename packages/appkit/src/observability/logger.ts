import {
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { getWideEvent } from "./context";
import { createDebug } from "./debug";
import type { ScopedOTELBridge } from "./otel/bridge";
import type {
  ErrorLogOptions,
  ILogger,
  LogContext,
  MetricOptions,
  SpanOptions,
} from "./types";

/**
 * Logger
 * - Responsible for logging messages to the console and OTEL
 */
export class Logger implements ILogger {
  private readonly scope: string;
  private readonly obug: ReturnType<typeof createDebug>;
  private readonly otel: ScopedOTELBridge;

  constructor(scope: string, otel: ScopedOTELBridge) {
    this.scope = scope;
    this.obug = createDebug(scope);
    this.otel = otel;
  }

  /**
   * Log a debug message
   * @param message - The message to log
   * @param context - The context of the message
   */
  debug(message: string, context?: LogContext): void {
    if (context) {
      this.obug("%s %o", message, context);
    } else {
      this.obug(message);
    }
  }

  /**
   * Log a trace message for detailed debugging
   * Goes to: Terminal + OTEL logs + WideEvent
   * @param message - The message to log
   * @param context - The context of the message
   */
  trace(message: string, context?: LogContext): void {
    // Terminal output with DEBUG=appkit:*
    this.debug(message, context);

    // Add to WideEvent for request correlation
    const event = getWideEvent();
    if (event) {
      event.addLog("debug", message, context);
      if (context) {
        event.setContext(this.scope, context);
      }
    }

    // Send to OTEL logs (unlike debug, this goes to observability backend)
    this.otel.emitLog("debug", message, context);
  }

  /**
   * Log an info message
   * @param message - The message to log
   * @param context - The context of the message
   */
  info(message: string, context?: LogContext): void {
    this.debug(message, context);

    // add to wide event if in request context
    const event = getWideEvent();
    if (event) {
      event.addLog("info", message, context);
      // also merge into scoped context for the summary
      if (context) {
        event.setContext(this.scope, context);
      }
    }

    // add as span event to current span (if any)
    if (context) {
      const currentSpan = trace.getActiveSpan();
      currentSpan?.addEvent(message, context as Attributes);
    }
  }
  /**
   * Log a warning message
   * @param message - The message to log
   * @param context - The context of the message
   */
  warn(message: string, context?: LogContext): void {
    this.debug(`WARN: ${message}`, context);

    const event = getWideEvent();
    if (event) {
      event.addLog("warn", message, context);
      if (context) {
        event.setContext(this.scope, context);
      }
    }

    if (context) {
      const currentSpan = trace.getActiveSpan();
      currentSpan?.addEvent(`WARN: ${message}`, context as Attributes);
    }
  }

  /**
   * Log an error message
   * @param message - The message to log
   * @param error - The error to log
   * @param context - The context of the message
   * @param options - Optional error logging configuration
   */
  error(
    message: string,
    error?: Error,
    context?: LogContext,
    options?: ErrorLogOptions,
  ): void {
    const fullContext = error
      ? { ...context, error: error.message, stack: error.stack }
      : context;

    this.debug(`ERROR: ${message}`, fullContext);

    const event = getWideEvent();
    if (event) {
      if (error) {
        event.setError(error);
      }
      event.addLog("error", message, context);
      if (context) {
        event.setContext(this.scope, context);
      }
    }

    // Record on current span (default: true)
    const recordOnSpan = options?.recordOnSpan ?? true;
    if (recordOnSpan) {
      const currentSpan = trace.getActiveSpan();
      if (currentSpan) {
        if (error) {
          currentSpan.recordException(error);
        }
        if (fullContext) {
          currentSpan.addEvent(`ERROR: ${message}`, fullContext as Attributes);
        }
      }
    }
  }

  /**
   * Execute a function within a traced span
   * @param name - The name of the span
   * @param fn - The function to execute within the span
   * @param options - The options for the span
   * @returns The result of the function
   */
  async span<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T> {
    const spanName = `${this.scope}.${name}`;

    return this.otel.startActiveSpan(
      spanName,
      options?.attributes || {},
      async (span) => {
        const event = getWideEvent();
        event?.setComponent(this.scope, name);

        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          event?.setError(error as Error);
          throw error;
        }
      },
    );
  }

  /**
   * Create a counter metric
   * @param name - The name of the counter
   * @param options - The options for the counter
   * @returns The counter
   */
  counter(name: string, options?: MetricOptions): Counter {
    return this.otel.createCounter(`${this.scope}.${name}`, options);
  }

  /**
   * Create a histogram metric
   * @param name - The name of the histogram
   * @param options - The options for the histogram
   * @returns The histogram
   */
  histogram(name: string, options?: MetricOptions): Histogram {
    return this.otel.createHistogram(`${this.scope}.${name}`, options);
  }

  /**
   * Record context to WideEvent and current span without generating a log entry.
   * Use this to enrich the request context with metadata.
   * @param context - Context data to record
   */
  recordContext(context: LogContext): void {
    // Add to WideEvent context (scoped)
    const event = getWideEvent();
    if (event) {
      event.setContext(this.scope, context);
    }

    // Add to current span as attributes (not an event)
    const currentSpan = trace.getActiveSpan();
    if (currentSpan) {
      for (const [key, value] of Object.entries(context)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          currentSpan.setAttribute(`${this.scope}.${key}`, value);
        }
      }
    }
  }

  /**
   * Get the current WideEvent if in request context (advanced usage).
   * Returns undefined if called outside of a request context.
   * @returns The current WideEvent or undefined
   */
  getEvent() {
    return getWideEvent();
  }

  /**
   * Create a child logger with additional scope.
   * The child scope will be appended to the parent scope with a colon separator.
   * @param childScope - The additional scope name to append
   * @returns A new ILogger instance with the combined scope
   * @example
   * const parentLogger = LoggerManager.getLogger("analytics");
   * const childLogger = parentLogger.child("query");
   * // childLogger scope: "analytics:query"
   */
  child(childScope: string): ILogger {
    const newScope = `${this.scope}:${childScope}`;
    return new Logger(newScope, this.otel.createScoped(newScope));
  }
}
